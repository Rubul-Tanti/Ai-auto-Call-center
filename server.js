const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { Readable } = require('stream');

require('dotenv').config();

// Set FFmpeg path only on Windows (local development)
if (process.platform === 'win32') {
  ffmpeg.setFfmpegPath('C:\\Users\\rubul\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0-full_build\\bin\\ffmpeg.exe');
}
// On Railway/Linux, FFmpeg will be installed via nixpacks and available in PATH

// Initialize Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const CONFIG = {
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  VOICEFLOW_API_KEY: process.env.VOICEFLOW_API_KEY,
  VOICEFLOW_VERSION_ID: process.env.VOICEFLOW_VERSION_ID,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
  PORT: process.env.PORT || 8080
};

// Store active sessions
const sessions = new Map();

// Log startup
console.log('\n' + '='.repeat(70));
console.log('VOICE AI SERVER STARTING');
console.log('='.repeat(70));
console.log('Checking API Keys:');
console.log('  DEEPGRAM_API_KEY:', CONFIG.DEEPGRAM_API_KEY ? '✓ SET' : '✗ MISSING');
console.log('  VOICEFLOW_API_KEY:', CONFIG.VOICEFLOW_API_KEY ? '✓ SET' : '✗ MISSING');
console.log('  VOICEFLOW_VERSION_ID:', CONFIG.VOICEFLOW_VERSION_ID ? '✓ SET' : '✗ MISSING');
console.log('  ELEVENLABS_API_KEY:', CONFIG.ELEVENLABS_API_KEY ? '✓ SET' : '✗ MISSING');
console.log('  ELEVENLABS_VOICE_ID:', CONFIG.ELEVENLABS_VOICE_ID ? '✓ SET' : '✗ MISSING');
console.log('='.repeat(70) + '\n');

// Helper function to convert MP3 to mulaw
async function convertMp3ToMulaw(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const buffers = [];
    const readableStream = new Readable();
    readableStream.push(mp3Buffer);
    readableStream.push(null);

    ffmpeg(readableStream)
      .inputFormat('mp3')
      .audioCodec('pcm_mulaw')
      .audioFrequency(8000)
      .audioChannels(1)
      .format('mulaw')
      .on('error', (err) => {
        console.error('FFmpeg error:', err.message);
        reject(err);
      })
      .pipe()
      .on('data', (chunk) => {
        buffers.push(chunk);
      })
      .on('end', () => {
        resolve(Buffer.concat(buffers));
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

class VoiceSession {
  constructor(exotelWs) {
    this.exotelWs = exotelWs;
    this.deepgramWs = null;
    this.sessionId = this.generateSessionId();
    this.isProcessing = false;
    this.heartbeatInterval = null;
    
    console.log(`[${this.sessionId}] ✓ Session created`);
    
    this.exotelWs.on('ping', () => this.exotelWs.pong());
    
    this.initDeepgram();
    this.startHeartbeat();
  }

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.exotelWs && this.exotelWs.readyState === WebSocket.OPEN) {
        this.exotelWs.ping();
      }
    }, 5000);
  }

  initDeepgram() {
    const deepgramUrl = `wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&punctuate=true&interim_results=false`;
    
    this.deepgramWs = new WebSocket(deepgramUrl, {
      headers: {
        'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`
      }
    });

    this.deepgramWs.on('open', () => {
      console.log(`[${this.sessionId}] ✓ Deepgram WebSocket connected`);
    });

    this.deepgramWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data);
        
        if (response.channel?.alternatives?.[0]?.transcript) {
          const transcript = response.channel.alternatives[0].transcript;
          
          if (transcript.trim() && response.is_final && !this.isProcessing) {
            console.log(`[${this.sessionId}] ✓ USER SAID: "${transcript}"`);
            this.isProcessing = true;
            await this.processWithVoiceflow(transcript);
            this.isProcessing = false;
          }
        }
      } catch (error) {
        console.error(`[${this.sessionId}] ✗ Deepgram error:`, error.message);
        this.isProcessing = false;
      }
    });

    this.deepgramWs.on('error', (error) => {
      console.error(`[${this.sessionId}] ✗ Deepgram connection error:`, error.message);
    });

    this.deepgramWs.on('close', () => {
      console.log(`[${this.sessionId}] ✗ Deepgram disconnected`);
    });
  }

  async processWithVoiceflow(userInput) {
    try {
      console.log(`[${this.sessionId}] → Sending to Voiceflow...`);
      
      const response = await axios.post(
        `https://general-runtime.voiceflow.com/state/user/${this.sessionId}/interact`,
        {
          action: {
            type: 'text',
            payload: userInput
          },
          config: {
            tts: false,
            stripSSML: true
          }
        },
        {
          headers: {
            'Authorization': CONFIG.VOICEFLOW_API_KEY,
            'Content-Type': 'application/json',
            'versionID': CONFIG.VOICEFLOW_VERSION_ID
          },
          timeout: 10000
        }
      );

      let botResponse = '';
      if (response.data && Array.isArray(response.data)) {
        response.data.forEach(trace => {
          if (trace.type === 'text' && trace.payload?.message) {
            botResponse += trace.payload.message + ' ';
          } else if (trace.type === 'speak' && trace.payload?.message) {
            botResponse += trace.payload.message + ' ';
          }
        });
      }

      botResponse = botResponse.trim();
      
      if (botResponse) {
        console.log(`[${this.sessionId}] ✓ BOT SAYS: "${botResponse}"`);
        await this.convertToSpeech(botResponse);
      } else {
        console.log(`[${this.sessionId}] ✗ No response from Voiceflow`);
      }
    } catch (error) {
      console.error(`[${this.sessionId}] ✗ Voiceflow error:`, error.message);
      await this.convertToSpeech("Sorry, I didn't understand that. Please try again.");
    }
  }

  async convertToSpeech(text) {
    try {
      console.log(`[${this.sessionId}] → Converting text to speech: "${text}"`);
      console.log(`[${this.sessionId}] → Using Voice ID: ${CONFIG.ELEVENLABS_VOICE_ID}`);
      
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.ELEVENLABS_VOICE_ID}/stream`,
        {
          text: text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        },
        {
          headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
            'xi-api-key': CONFIG.ELEVENLABS_API_KEY
          },
          responseType: 'arraybuffer',
          timeout: 30000
        }
      );

      console.log(`[${this.sessionId}] ✓ Received MP3 audio (${response.data.length} bytes)`);
      console.log(`[${this.sessionId}] → Starting FFmpeg conversion...`);

      const mulawAudio = await convertMp3ToMulaw(Buffer.from(response.data));
      console.log(`[${this.sessionId}] ✓ Converted to mulaw (${mulawAudio.length} bytes)`);

      if (this.exotelWs.readyState === WebSocket.OPEN) {
        console.log(`[${this.sessionId}] ✓ WebSocket is OPEN, sending audio...`);
        const chunkSize = 1024;
        let sent = 0;
        for (let i = 0; i < mulawAudio.length; i += chunkSize) {
          const chunk = mulawAudio.slice(i, i + chunkSize);
          this.exotelWs.send(chunk);
          sent++;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        console.log(`[${this.sessionId}] ✓ Audio sent to Exotel (${sent} chunks)\n`);
      } else {
        console.error(`[${this.sessionId}] ✗ Exotel WebSocket not open (state: ${this.exotelWs.readyState})\n`);
      }
    } catch (error) {
      console.error(`[${this.sessionId}] ✗ TTS error:`, error.message);
      console.error(`[${this.sessionId}] Error details:`, error);
      if (error.response) {
        console.error(`[${this.sessionId}] Response status:`, error.response.status);
        console.error(`[${this.sessionId}] Response data:`, error.response.data);
      }
    }
  }

  sendAudioToDeepgram(audioData) {
    if (this.deepgramWs && this.deepgramWs.readyState === WebSocket.OPEN) {
      this.deepgramWs.send(audioData);
    }
  }

  cleanup() {
    if (this.deepgramWs) {
      this.deepgramWs.close();
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    console.log(`[${this.sessionId}] ✗ Session ended\n`);
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('\n' + '='.repeat(70));
  console.log('📞 NEW CALL CONNECTED');
  console.log('='.repeat(70));
  
  const session = new VoiceSession(ws);
  sessions.set(ws, session);

  // Send greeting
  setTimeout(async () => {
    try {
      await session.convertToSpeech("Hello! How can I help you today?");
    } catch (error) {
      console.error(`[${session.sessionId}] Greeting error:`, error.message);
    }
  }, 1000);

  ws.on('message', (message) => {
    if (message instanceof Buffer) {
      console.log(`[${session.sessionId}] 📊 Received audio chunk: ${message.length} bytes`);
      session.sendAudioToDeepgram(message);
    }
  });

  ws.on('close', () => {
    console.log('='.repeat(70));
    console.log('📞 CALL DISCONNECTED');
    console.log('='.repeat(70) + '\n');
    session.cleanup();
    sessions.delete(ws);
  });

  ws.on('error', (error) => {
    console.error(`[${session.sessionId}] ✗ WebSocket error:`, error.message);
    session.cleanup();
    sessions.delete(ws);
  });
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    activeSessions: sessions.size,
    timestamp: new Date().toISOString()
  });
});

// Start server - listen on all interfaces for Railway
server.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(70));
  console.log('VOICE AI PIPELINE SERVER STARTED');
  console.log('='.repeat(70));
  console.log(`Port: ${CONFIG.PORT}`);
  console.log(`Listening on: 0.0.0.0:${CONFIG.PORT}`);
  console.log(`WebSocket URL: wss://ai-auto-call-center.railway.app`);
  console.log(`Health check: https://ai-auto-call-center.railway.app/health`);
  console.log('='.repeat(70) + '\n');
});

// Error handlers
process.on('uncaughtException', (error) => {
  console.error('✗ UNCAUGHT EXCEPTION:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('✗ UNHANDLED REJECTION:', reason);
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  
  // Force exit after 10 seconds
  setTimeout(() => {
    console.error('Forcing exit...');
    process.exit(1);
  }, 10000);
});
console.log('ElevenLabs API Key (first 20 chars):', CONFIG.ELEVENLABS_API_KEY?.substring(0, 20));
// Keep process alive and log health
setInterval(() => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Health check - Active sessions: ${sessions.size}`);
}, 30000);
