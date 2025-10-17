const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { Readable } = require('stream');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

require('dotenv').config();

if (process.platform === 'win32') {
  ffmpeg.setFfmpegPath('C:\\Users\\rubul\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0-full_build\\bin\\ffmpeg.exe');
}

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const CONFIG = {
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  VOICEFLOW_API_KEY: process.env.VOICEFLOW_API_KEY,
  VOICEFLOW_VERSION_ID: process.env.VOICEFLOW_VERSION_ID,
  PORT: process.env.PORT || 8080
};

const sessions = new Map();

console.log('\n' + '='.repeat(70));
console.log('VOICE AI SERVER STARTING');
console.log('='.repeat(70));
console.log('API Keys:');
console.log('  DEEPGRAM:', CONFIG.DEEPGRAM_API_KEY ? 'SET' : 'MISSING');
console.log('  VOICEFLOW_KEY:', CONFIG.VOICEFLOW_API_KEY ? 'SET' : 'MISSING');
console.log('  VOICEFLOW_VERSION:', CONFIG.VOICEFLOW_VERSION_ID ? 'SET' : 'MISSING');
console.log('='.repeat(70) + '\n');

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
      .on('error', reject)
      .pipe()
      .on('data', (chunk) => buffers.push(chunk))
      .on('end', () => resolve(Buffer.concat(buffers)))
      .on('error', reject);
  });
}

class VoiceSession {
  constructor(exotelWs, streamSid, callSid) {
    this.exotelWs = exotelWs;
    this.deepgramConnection = null;
    this.streamSid = streamSid;
    this.callSid = callSid;
    this.isProcessing = false;
    this.heartbeatInterval = null;
    this.audioReceivedCount = 0;
    this.audioSentCount = 0;

    console.log(`[${this.streamSid}] Session created | Call: ${this.callSid}`);

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
    const deepgram = createClient(CONFIG.DEEPGRAM_API_KEY);

    this.deepgramConnection = deepgram.listen.live({
      model: 'nova-3',
      language: 'en-US',
      smart_format: true,
      interim_results: true,
      vad: true,
      endpointing: '1ms'
    });

    this.deepgramConnection.on(LiveTranscriptionEvents.Open, () => {
      console.log(`[${this.streamSid}] Deepgram connected`);
    });

    this.deepgramConnection.on(LiveTranscriptionEvents.Transcript, async (data) => {
      try {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        const isFinal = data.is_final;
        const speechFinal = data.speech_final;

        if (transcript?.trim()) {
          if (isFinal && speechFinal) {
            console.log(`[${this.streamSid}] FINAL: "${transcript}"`);
            console.log(`[${this.streamSid}] Requesting response...`);

            if (!this.isProcessing) {
              this.isProcessing = true;
              await this.processWithVoiceflow(transcript);
              this.isProcessing = false;
            }
          } else if (!isFinal) {
            console.log(`[${this.streamSid}] interim: "${transcript}"`);
          }
        }
      } catch (error) {
        console.error(`[${this.streamSid}] Transcript error:`, error.message);
        this.isProcessing = false;
      }
    });

    this.deepgramConnection.on(LiveTranscriptionEvents.Error, (error) => {
      console.error(`[${this.streamSid}] Deepgram error:`, error.message);
    });

    this.deepgramConnection.on(LiveTranscriptionEvents.Close, () => {
      console.log(`[${this.streamSid}] Deepgram closed`);
    });
  }

  async processWithVoiceflow(userInput) {
    try {
      console.log(`[${this.streamSid}] Calling Voiceflow...`);

      const response = await axios.post(
        `https://general-runtime.voiceflow.com/state/user/${this.streamSid}/interact`,
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
          if ((trace.type === 'text' || trace.type === 'speak') && trace.payload?.message) {
            botResponse += trace.payload.message + ' ';
          }
        });
      }

      botResponse = botResponse.trim();

      if (botResponse) {
        console.log(`[${this.streamSid}] BOT: "${botResponse}"`);
        await this.convertToSpeech(botResponse);
      } else {
        console.log(`[${this.streamSid}] No response from Voiceflow`);
      }
    } catch (error) {
      console.error(`[${this.streamSid}] Voiceflow error:`, error.message);
      await this.convertToSpeech("Sorry, I didn't understand that.");
    }
  }

  async convertToSpeech(text) {
    try {
      console.log(`[${this.streamSid}] Converting to speech: "${text}"`);

      const deepgram = createClient(CONFIG.DEEPGRAM_API_KEY);

      const response = await deepgram.speak.request(
        { text },
        {
          model: 'aura-2-thalia-en',
          encoding: 'linear16',
          sample_rate: 8000
        }
      );

      const stream = await response.getStream();

      if (!stream) {
        throw new Error('No audio stream from Deepgram');
      }

      const reader = stream.getReader();
      const chunks = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const audioBuffer = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));

      console.log(`[${this.streamSid}] Speech ready (${audioBuffer.length} bytes)`);
      await this.sendAudioToExotel(audioBuffer);
    } catch (error) {
      console.error(`[${this.streamSid}] TTS error:`, error.message);
    }
  }

  async sendAudioToExotel(pcmAudio) {
    return new Promise((resolve) => {
      if (this.exotelWs.readyState !== WebSocket.OPEN) {
        console.error(`[${this.streamSid}] WebSocket not open`);
        resolve();
        return;
      }

      if (!pcmAudio || pcmAudio.length === 0) {
        console.error(`[${this.streamSid}] No audio data`);
        resolve();
        return;
      }

      const CHUNK_SIZE = 577;
      let sent = 0;
      let index = 0;

      console.log(`[${this.streamSid}] Sending ${Math.ceil(pcmAudio.length / CHUNK_SIZE)} chunks...`);

      const sendNextChunk = () => {
        if (index >= pcmAudio.length) {
          this.audioSentCount += sent;
          console.log(`[${this.streamSid}] Audio sent (${sent} chunks)\n`);
          resolve();
          return;
        }

        if (this.exotelWs.readyState !== WebSocket.OPEN) {
          console.error(`[${this.streamSid}] WebSocket closed`);
          resolve();
          return;
        }

        const chunk = pcmAudio.slice(index, Math.min(index + CHUNK_SIZE, pcmAudio.length));

        try {
          this.exotelWs.send(chunk);
          sent++;
          index += CHUNK_SIZE;
          setTimeout(sendNextChunk, 72);
        } catch (error) {
          console.error(`[${this.streamSid}] Send error:`, error.message);
          resolve();
        }
      };

      sendNextChunk();
    });
  }

  sendAudioToDeepgram(audioData) {
    if (this.deepgramConnection) {
      try {
        this.deepgramConnection.send(audioData);
      } catch (error) {
        console.error(`[${this.streamSid}] Deepgram send error:`, error.message);
      }
    }
  }

  cleanup() {
    if (this.deepgramConnection) {
      this.deepgramConnection.finish();
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    console.log(`[${this.streamSid}] Session ended\n`);
  }
}

wss.on('connection', (ws) => {
  console.log('\n' + '='.repeat(70));
  console.log('CALL CONNECTED');
  console.log('='.repeat(70));

  const session = new VoiceSession(ws, `stream_${Date.now()}`, 'unknown');
  sessions.set(ws, session);

  setTimeout(async () => {
    try {
      console.log(`[${session.streamSid}] Sending greeting...`);
      await session.convertToSpeech("Hello! How can I help you today?");
    } catch (error) {
      console.error(`[${session.streamSid}] Greeting error:`, error.message);
    }
  }, 1000);

  ws.on('message', (data) => {
    if (Buffer.isBuffer(data)) {
      session.audioReceivedCount++;
      if (session.audioReceivedCount % 10 === 0) {
        console.log(`[${session.streamSid}] Audio received (${session.audioReceivedCount} chunks)`);
      }
      session.sendAudioToDeepgram(data);
    }
  });

  ws.on('close', () => {
    console.log('='.repeat(70));
    console.log('CALL ENDED');
    console.log('='.repeat(70) + '\n');
    session.cleanup();
    sessions.delete(ws);
  });

  ws.on('error', (error) => {
    console.error(`[${session.streamSid}] WebSocket error:`, error.message);
    session.cleanup();
    sessions.delete(ws);
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.size,
    timestamp: new Date().toISOString()
  });
});

server.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(70));
  console.log('SERVER READY');
  console.log('='.repeat(70));
  console.log(`Port: ${CONFIG.PORT}`);
  console.log('='.repeat(70) + '\n');
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  sessions.forEach((session) => session.cleanup());
  server.close(() => {
    console.log('Closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
});
