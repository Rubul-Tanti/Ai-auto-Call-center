const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { Readable } = require('stream');
const { promisify } = require('util');
const stream = require('stream');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration - Replace with your actual API keys
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
        console.error('FFmpeg conversion error:', err);
        reject(err);
      })
      .on('end', () => {
        console.log('Audio conversion completed');
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
    this.conversationContext = [];
    this.isProcessing = false;
    this.heartbeatInterval = null;
    
    console.log(`[${this.sessionId}] Session created`);
    
    // Setup Exotel ping/pong handlers
    this.exotelWs.on('ping', () => {
      console.log(`[${this.sessionId}] Received ping from Exotel`);
      this.exotelWs.pong();
    });
    
    this.exotelWs.on('pong', () => {
      console.log(`[${this.sessionId}] Pong acknowledged`);
    });
    
    this.initDeepgram();
    this.startHeartbeat();
  }

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  startHeartbeat() {
    console.log(`[${this.sessionId}] Starting heartbeat`);
    this.heartbeatInterval = setInterval(() => {
      if (this.exotelWs && this.exotelWs.readyState === WebSocket.OPEN) {
        try {
          this.exotelWs.ping();
          console.log(`[${this.sessionId}] Heartbeat ping sent`);
        } catch (err) {
          console.error(`[${this.sessionId}] Heartbeat error:`, err.message);
        }
      }
    }, 5000); // Send ping every 5 seconds
  }

  initDeepgram() {
    const deepgramUrl = `wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&punctuate=true&interim_results=false`;
    
    this.deepgramWs = new WebSocket(deepgramUrl, {
      headers: {
        'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`
      }
    });

    this.deepgramWs.on('open', () => {
      console.log(`[${this.sessionId}] Deepgram connected`);
    });

    this.deepgramWs.on('message', async (data) => {
      try {
        const response = JSON.parse(data);
        
        if (response.channel?.alternatives?.[0]?.transcript) {
          const transcript = response.channel.alternatives[0].transcript;
          
          if (transcript.trim() && response.is_final && !this.isProcessing) {
            console.log(`[${this.sessionId}] Transcribed: ${transcript}`);
            this.isProcessing = true;
            await this.processWithVoiceflow(transcript);
            this.isProcessing = false;
          }
        }
      } catch (error) {
        console.error(`[${this.sessionId}] Deepgram message error:`, error);
        this.isProcessing = false;
      }
    });

    this.deepgramWs.on('error', (error) => {
      console.error(`[${this.sessionId}] Deepgram error:`, error);
    });

    this.deepgramWs.on('close', () => {
      console.log(`[${this.sessionId}] Deepgram disconnected`);
    });
  }

  async processWithVoiceflow(userInput) {
    try {
      console.log(`[${this.sessionId}] Sending to Voiceflow: ${userInput}`);
      
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
          }
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
        console.log(`[${this.sessionId}] Voiceflow response: ${botResponse}`);
        await this.convertToSpeech(botResponse);
      } else {
        console.log(`[${this.sessionId}] No response from Voiceflow`);
      }
    } catch (error) {
      console.error(`[${this.sessionId}] Voiceflow error:`, error.message);
      await this.convertToSpeech("I'm having trouble processing that. Can you please repeat?");
    }
  }

  async convertToSpeech(text) {
    try {
      console.log(`[${this.sessionId}] Step 1: Converting to speech: ${text}`);
      
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

      console.log(`[${this.sessionId}] Step 2: Received audio from ElevenLabs (${response.data.length} bytes), converting format...`);

      const mulawAudio = await convertMp3ToMulaw(Buffer.from(response.data));
      console.log(`[${this.sessionId}] Step 3: Converted to mulaw (${mulawAudio.length} bytes)`);

      if (this.exotelWs.readyState === WebSocket.OPEN) {
        console.log(`[${this.sessionId}] Step 4: Exotel WebSocket is OPEN, sending audio in chunks...`);
        const chunkSize = 1024;
        for (let i = 0; i < mulawAudio.length; i += chunkSize) {
          const chunk = mulawAudio.slice(i, i + chunkSize);
          this.exotelWs.send(chunk);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        console.log(`[${this.sessionId}] Audio sent to Exotel successfully`);
      } else {
        console.error(`[${this.sessionId}] Step 4: Exotel WebSocket NOT OPEN (state: ${this.exotelWs.readyState})`);
      }
    } catch (error) {
      console.error(`[${this.sessionId}] Speech conversion error:`, error.message);
      if (error.response) {
        console.error(`[${this.sessionId}] Error response:`, error.response.data);
      }
    }
  }

  sendAudioToDeepgram(audioData) {
    if (this.deepgramWs && this.deepgramWs.readyState === WebSocket.OPEN) {
      this.deepgramWs.send(audioData);
    } else {
      console.error(`[${this.sessionId}] Deepgram WebSocket not open (state: ${this.deepgramWs?.readyState})`);
    }
  }

  cleanup() {
    if (this.deepgramWs) {
      this.deepgramWs.close();
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    console.log(`[${this.sessionId}] Session cleaned up`);
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('='.repeat(60));
  console.log('NEW EXOTEL CONNECTION ESTABLISHED');
  console.log('Timestamp:', new Date().toISOString());
  console.log('='.repeat(60));
  
  const session = new VoiceSession(ws);
  sessions.set(ws, session);

  // Send initial greeting
  console.log(`[${session.sessionId}] Scheduling greeting in 1 second...`);
  setTimeout(async () => {
    try {
      console.log(`[${session.sessionId}] Sending greeting...`);
      await session.convertToSpeech("Hello! How can I help you today?");
      console.log(`[${session.sessionId}] Greeting sent successfully`);
    } catch (error) {
      console.error(`[${session.sessionId}] Error sending greeting:`, error);
    }
  }, 1000);

  ws.on('message', (message) => {
    try {
      console.log(`[${session.sessionId}] Message received - Type: ${message instanceof Buffer ? 'BINARY' : 'TEXT'}, Size: ${message.length || message.toString().length} bytes`);
      
      if (message instanceof Buffer) {
        // Audio data from Exotel
        console.log(`[${session.sessionId}] Forwarding audio to Deepgram (${message.length} bytes)`);
        session.sendAudioToDeepgram(message);
      } else {
        // Handle JSON control messages
        try {
          const data = JSON.parse(message);
          console.log(`[${session.sessionId}] Control message:`, data);
          
          if (data.event === 'start') {
            console.log(`[${session.sessionId}] Call started`);
          } else if (data.event === 'stop') {
            console.log(`[${session.sessionId}] Call ended`);
          }
        } catch (parseError) {
          // Treat as audio data
          console.log(`[${session.sessionId}] Treating message as audio data`);
          session.sendAudioToDeepgram(message);
        }
      }
    } catch (error) {
      console.error(`[${session.sessionId}] Message handling error:`, error);
    }
  });

  ws.on('close', () => {
    console.log('='.repeat(60));
    console.log(`[${session.sessionId}] EXOTEL CONNECTION CLOSED`);
    console.log('='.repeat(60));
    session.cleanup();
    sessions.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('='.repeat(60));
    console.error(`[${session.sessionId}] WEBSOCKET ERROR:`, error);
    console.error('='.repeat(60));
    session.cleanup();
    sessions.delete(ws);
  });
});

// Health check endpoint with more info
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.json({ 
    status: 'ok',
    activeSessions: sessions.size,
    timestamp: new Date().toISOString(),
    config: {
      hasDeepgramKey: !!CONFIG.DEEPGRAM_API_KEY,
      hasVoiceflowKey: !!CONFIG.VOICEFLOW_API_KEY,
      hasElevenLabsKey: !!CONFIG.ELEVENLABS_API_KEY
    }
  });
});

// Start server
server.listen(CONFIG.PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('VOICE AI PIPELINE SERVER STARTED');
  console.log('='.repeat(60));
  console.log(`Port: ${CONFIG.PORT}`);
  console.log(`WebSocket URL: wss://ai-auto-call-center.railway.app`);
  console.log(`Health check: https://ai-auto-call-center.railway.app/health`);
  console.log(`Active sessions: ${sessions.size}`);
  console.log('='.repeat(60) + '\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  wss.clients.forEach(client => {
    const session = sessions.get(client);
    if (session) {
      session.cleanup();
    }
    client.close();
  });
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
