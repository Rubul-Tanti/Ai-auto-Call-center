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
    this.initDeepgram();
  }

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  initDeepgram() {
    // Connect to Deepgram WebSocket for real-time transcription
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

      // Extract text responses from Voiceflow
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
      // Fallback response
      await this.convertToSpeech("I'm having trouble processing that. Can you please repeat?");
    }
  }

  async convertToSpeech(text) {
    try {
      console.log(`[${this.sessionId}] Converting to speech: ${text}`);
      
      // Get audio from ElevenLabs
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
          responseType: 'arraybuffer'
        }
      );

      console.log(`[${this.sessionId}] Received audio from ElevenLabs, converting format...`);

      // Convert MP3 to mulaw format for Exotel
      const mulawAudio = await convertMp3ToMulaw(Buffer.from(response.data));

      // Send converted audio back to Exotel
      if (this.exotelWs.readyState === WebSocket.OPEN) {
        // Send in chunks to avoid overwhelming the connection
        const chunkSize = 1024; // 1KB chunks
        for (let i = 0; i < mulawAudio.length; i += chunkSize) {
          const chunk = mulawAudio.slice(i, i + chunkSize);
          this.exotelWs.send(chunk);
          // Small delay between chunks for smoother playback
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        console.log(`[${this.sessionId}] Audio sent to Exotel (${mulawAudio.length} bytes)`);
      } else {
        console.error(`[${this.sessionId}] Exotel WebSocket not open`);
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
    }
  }

  cleanup() {
    if (this.deepgramWs) {
      this.deepgramWs.close();
    }
    console.log(`[${this.sessionId}] Session cleaned up`);
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('New Exotel connection established');
  
  const session = new VoiceSession(ws);
  sessions.set(ws, session);

  // Send initial greeting
  setTimeout(async () => {
    try {
      await session.convertToSpeech("Hello! How can I help you today?");
    } catch (error) {
      console.error(`[${session.sessionId}] Error sending greeting:`, error);
    }
  }, 1000);

  ws.on('message', (message) => {
    try {
      // Check if message is JSON (control message) or binary (audio)
      if (message instanceof Buffer) {
        // Audio data from Exotel - forward to Deepgram
        session.sendAudioToDeepgram(message);
      } else {
        // Handle JSON control messages if needed
        try {
          const data = JSON.parse(message);
          console.log(`[${session.sessionId}] Control message:`, data);
          
          // Handle specific control messages if needed
          if (data.event === 'start') {
            console.log(`[${session.sessionId}] Call started`);
          } else if (data.event === 'stop') {
            console.log(`[${session.sessionId}] Call ended`);
          }
        } catch (parseError) {
          // If not JSON, treat as audio data
          session.sendAudioToDeepgram(message);
        }
      }
    } catch (error) {
      console.error(`[${session.sessionId}] Message handling error:`, error);
    }
  });

  ws.on('close', () => {
    console.log(`[${session.sessionId}] Exotel connection closed`);
    session.cleanup();
    sessions.delete(ws);
  });

  ws.on('error', (error) => {
    console.error(`[${session.sessionId}] WebSocket error:`, error);
    session.cleanup();
    sessions.delete(ws);
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    activeSessions: sessions.size,
    timestamp: new Date().toISOString()
  });
});

// Start server
server.listen(CONFIG.PORT, () => {
  console.log(`Voice AI Pipeline Server running on port ${CONFIG.PORT}`);
  console.log(`WebSocket URL: ws://localhost:${CONFIG.PORT}`);
  console.log(`Health check: http://localhost:${CONFIG.PORT}/health`);
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