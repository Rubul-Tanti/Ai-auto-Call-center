const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

// Set FFmpeg path only on Windows (local development)
if (process.platform === 'win32') {
  ffmpeg.setFfmpegPath('C:\\Users\\rubul\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0-full_build\\bin\\ffmpeg.exe');
}

// Initialize Google Cloud TTS
const textToSpeech = require('@google-cloud/text-to-speech');

let ttsClient;

// Initialize Google Cloud client
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const credentialsJson = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    ttsClient = new textToSpeech.TextToSpeechClient({
      credentials: credentialsJson
    });
    console.log('✓ Google Cloud TTS initialized');
  } catch (error) {
    console.error('✗ Failed to initialize Google Cloud TTS:', error.message);
  }
}

// Initialize Express app
const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const CONFIG = {
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  VOICEFLOW_API_KEY: process.env.VOICEFLOW_API_KEY,
  VOICEFLOW_VERSION_ID: process.env.VOICEFLOW_VERSION_ID,
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
console.log('  GOOGLE_CLOUD_TTS:', ttsClient ? '✓ INITIALIZED' : '✗ NOT READY');
console.log('='.repeat(70) + '\n');

// Helper function to convert MP3 to Linear PCM (16-bit, 8kHz, mono)
async function convertMp3ToPcm(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const buffers = [];
    const readableStream = new Readable();
    readableStream.push(mp3Buffer);
    readableStream.push(null);

    ffmpeg(readableStream)
      .inputFormat('mp3')
      .audioCodec('pcm_s16le')
      .audioFrequency(8000)
      .audioChannels(1)
      .format('s16le')
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
  constructor(exotelWs, sessionId, callSid) {
    this.exotelWs = exotelWs;
    this.deepgramWs = null;
    this.sessionId = sessionId;
    this.callSid = callSid;
    this.isProcessing = false;
    this.heartbeatInterval = null;
    this.streamStarted = false;
    this.audioBuffer = [];
    this.silenceTimeout = null;
    
    console.log(`[${this.sessionId}] ✓ Session created | Call SID: ${this.callSid}`);
    
    this.exotelWs.on('ping', () => {
      if (this.exotelWs.readyState === WebSocket.OPEN) {
        this.exotelWs.pong();
      }
    });
    
    this.initDeepgram();
    this.startHeartbeat();
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.exotelWs && this.exotelWs.readyState === WebSocket.OPEN) {
        this.exotelWs.ping();
      }
    }, 5000);
  }

  initDeepgram() {
    const deepgramUrl = `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&punctuate=true&interim_results=false`;
    
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
      
      if (!ttsClient) {
        throw new Error('Google Cloud TTS not initialized');
      }

      const request = {
        input: { text: text },
        voice: {
          languageCode: 'en-US',
          name: 'en-US-Neural2-C',
        },
        audioConfig: {
          audioEncoding: 'MP3',
          pitch: 0,
          speakingRate: 1,
        },
      };

      console.log(`[${this.sessionId}] → Calling Google Cloud TTS API...`);
      const [response] = await ttsClient.synthesizeSpeech(request);
      const mp3Audio = response.audioContent;

      console.log(`[${this.sessionId}] ✓ Received MP3 audio (${mp3Audio.length} bytes)`);
      console.log(`[${this.sessionId}] → Converting MP3 to Linear PCM (16-bit, 8kHz, mono)...`);

      const pcmAudio = await convertMp3ToPcm(Buffer.from(mp3Audio));
      console.log(`[${this.sessionId}] ✓ Converted to PCM (${pcmAudio.length} bytes)`);

      await this.sendAudioToExotel(pcmAudio);
    } catch (error) {
      console.error(`[${this.sessionId}] ✗ TTS error:`, error.message);
      if (error.response) {
        console.error(`[${this.sessionId}] Response status:`, error.response.status);
      }
    }
  }

  async sendAudioToExotel(pcmAudio) {
    return new Promise((resolve) => {
      if (this.exotelWs.readyState !== WebSocket.OPEN) {
        console.error(`[${this.sessionId}] ✗ Exotel WebSocket not open (state: ${this.exotelWs.readyState})`);
        resolve();
        return;
      }

      console.log(`[${this.sessionId}] ✓ WebSocket is OPEN, sending audio in base64...`);
      
      // 100ms of audio at 8kHz = 800 samples = 1600 bytes (16-bit mono)
      const CHUNK_SIZE = 1600;
      let sent = 0;
      let index = 0;

      const sendNextChunk = () => {
        if (index >= pcmAudio.length) {
          console.log(`[${this.sessionId}] ✓ Audio transmission complete (${sent} chunks, ${pcmAudio.length} bytes total)\n`);
          resolve();
          return;
        }

        if (this.exotelWs.readyState !== WebSocket.OPEN) {
          console.error(`[${this.sessionId}] ✗ WebSocket disconnected during transmission`);
          resolve();
          return;
        }

        const chunk = pcmAudio.slice(index, Math.min(index + CHUNK_SIZE, pcmAudio.length));
        const base64Payload = chunk.toString('base64');
        
        const message = JSON.stringify({
          type: 'media',
          payload: base64Payload
        });
        
        try {
          this.exotelWs.send(message);
          sent++;
          index += CHUNK_SIZE;
          console.log(`[${this.sessionId}] 📤 Sent chunk ${sent} (${chunk.length} bytes -> base64)`);
          
          // 100ms timing between chunks
          setTimeout(sendNextChunk, 100);
        } catch (error) {
          console.error(`[${this.sessionId}] ✗ Error sending chunk:`, error.message);
          resolve();
        }
      };

      sendNextChunk();
    });
  }

  handleExotelEvent(message) {
    try {
      let event;
      
      // Try to parse as JSON first (Exotel events)
      try {
        event = JSON.parse(message);
      } catch {
        // If not JSON, it might be raw audio data
        console.log(`[${this.sessionId}] 📊 Received binary audio data: ${message.length} bytes`);
        this.sendAudioToDeepgram(message);
        return;
      }

      if (!event.type) {
        console.log(`[${this.sessionId}] ⚠ Event missing type field`);
        return;
      }

      console.log(`[${this.sessionId}] 📨 Exotel event: ${event.type}`);

      switch(event.type) {
        case 'connected':
          console.log(`[${this.sessionId}] ✓ CONNECTED - WebSocket handshake successful, initializing bot`);
          break;
          
        case 'start':
          console.log(`[${this.sessionId}] ✓ START - Audio streaming beginning from caller`);
          this.streamStarted = true;
          break;
          
        case 'media':
          if (event.payload) {
            try {
              // Decode base64 audio from Exotel
              const audioBuffer = Buffer.from(event.payload, 'base64');
              console.log(`[${this.sessionId}] 📥 Received media chunk: ${audioBuffer.length} bytes`);
              this.sendAudioToDeepgram(audioBuffer);
            } catch (err) {
              console.error(`[${this.sessionId}] ✗ Error decoding audio payload:`, err.message);
            }
          }
          break;
          
        case 'dtmf':
          console.log(`[${this.sessionId}] 🔘 DTMF digit detected: ${event.payload}`);
          break;
          
        case 'stop':
          console.log(`[${this.sessionId}] ⏹ STOP - Customer leg disconnected`);
          this.streamStarted = false;
          break;
          
        case 'clear':
          console.log(`[${this.sessionId}] 🔄 CLEAR - Resetting session context mid-call`);
          this.isProcessing = false;
          break;
          
        default:
          console.log(`[${this.sessionId}] ❓ Unknown event type: ${event.type}`);
      }
    } catch (error) {
      console.error(`[${this.sessionId}] ✗ Error handling Exotel event:`, error.message);
    }
  }

  sendAudioToDeepgram(audioData) {
    if (!this.deepgramWs || this.deepgramWs.readyState !== WebSocket.OPEN) {
      console.warn(`[${this.sessionId}] ⚠ Deepgram not ready (state: ${this.deepgramWs?.readyState})`);
      return;
    }
    
    try {
      this.deepgramWs.send(audioData);
    } catch (error) {
      console.error(`[${this.sessionId}] ✗ Error sending to Deepgram:`, error.message);
    }
  }

  cleanup() {
    if (this.deepgramWs && this.deepgramWs.readyState !== WebSocket.CLOSED) {
      this.deepgramWs.close();
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
    }
    console.log(`[${this.sessionId}] ✗ Session cleaned up\n`);
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('\n' + '='.repeat(70));
  console.log('📞 NEW CALL CONNECTED');
  console.log('='.repeat(70));
  
  // Extract parameters from URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId') || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const callSid = url.searchParams.get('callSid') || url.searchParams.get('call_sid') || 'unknown';
  
  console.log(`Session ID: ${sessionId}`);
  console.log(`Call SID: ${callSid}`);
  
  const session = new VoiceSession(ws, sessionId, callSid);
  sessions.set(ws, session);

  // Send greeting after connection is established
  setTimeout(async () => {
    try {
      console.log(`[${session.sessionId}] 🎤 Sending greeting...`);
      await session.convertToSpeech("Hello! How can I help you today?");
    } catch (error) {
      console.error(`[${session.sessionId}] ✗ Greeting error:`, error.message);
    }
  }, 1000);

  ws.on('message', (data) => {
    // Handle both text and binary messages
    if (typeof data === 'string') {
      session.handleExotelEvent(data);
    } else if (Buffer.isBuffer(data)) {
      console.log(`[${session.sessionId}] 📊 Received binary message: ${data.length} bytes`);
      session.handleExotelEvent(data);
    }
  });

  ws.on('close', () => {
    console.log('='.repeat(70));
    console.log('📞 CALL DISCONNECTED');
    console.log('='.repeat(70));
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

// Passthru endpoint for Exotel after stream ends
app.post('/passthru', (req, res) => {
  const { call_sid, session_id } = req.body;
  
  console.log(`\n[Passthru] Call SID: ${call_sid}, Session: ${session_id}`);
  console.log('[Passthru] Stream session ended - Routing options:');
  console.log('  1. Escalate to agent');
  console.log('  2. End call');
  console.log('  3. Route to another applet');
  
  // Example: Route to agent after successful bot interaction
  res.json({
    escalate: false, // Set to true to route to Exotel agent
    status: 'completed',
    message: 'Bot interaction completed'
  });
});

// Start server
server.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(70));
  console.log('✅ VOICE AI PIPELINE SERVER STARTED');
  console.log('='.repeat(70));
  console.log(`Port: ${CONFIG.PORT}`);
  console.log(`Listening on: 0.0.0.0:${CONFIG.PORT}`);
  console.log(`WebSocket Protocol: wss://`);
  console.log(`Health check: GET /health`);
  console.log(`Passthru endpoint: POST /passthru`);
  console.log('='.repeat(70) + '\n');
});

// Graceful shutdown
process.on('uncaughtException', (error) => {
  console.error('✗ UNCAUGHT EXCEPTION:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('✗ UNHANDLED REJECTION:', reason);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down gracefully...');
  
  // Close all sessions
  sessions.forEach((session, ws) => {
    session.cleanup();
    ws.close();
  });
  
  server.close(() => {
    console.log('✓ Server closed');
    process.exit(0);
  });
  
  setTimeout(() => {
    console.error('✗ Forced exit after timeout');
    process.exit(1);
  }, 10000);
});

// Health monitoring
setInterval(() => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] 📊 Health check - Active sessions: ${sessions.size}`);
}, 30000);
