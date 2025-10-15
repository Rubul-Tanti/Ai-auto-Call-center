const WebSocket = require('ws');
const fs = require('fs');

// This simulates what Exotel does
const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080'; // Use ws:// for local, wss:// for remote

console.log('🎤 Exotel Simulator - Testing Voice AI Server\n');
console.log(`Connecting to: ${SERVER_URL}`);

const ws = new WebSocket(SERVER_URL);
let audioCount = 0;

ws.on('open', () => {
  console.log('✓ Connected to server\n');
  console.log('📞 Simulating incoming call...\n');
});

ws.on('message', (data) => {
  if (data instanceof Buffer) {
    audioCount++;
    console.log(`✓ Audio chunk ${audioCount} received: ${data.length} bytes`);
    
    // Save audio for inspection
    fs.appendFileSync('server_response_audio.mulaw', data);
    
    // Simulate user speech after greeting (send some audio data)
    if (audioCount === 1) {
      console.log('\n📊 Server sent greeting audio');
      console.log('📢 Simulating user speech: "Hello, how are you?"');
      
      // Simulate audio input - send dummy mulaw audio
      setTimeout(() => {
        const dummyAudio = Buffer.alloc(8000); // 1 second of silence in mulaw
        ws.send(dummyAudio);
        console.log('📤 Sent simulated user audio to server\n');
      }, 2000);
    }
  }
});

ws.on('close', () => {
  console.log('\n' + '='.repeat(60));
  console.log('✗ Connection closed');
  console.log(`Total audio chunks received: ${audioCount}`);
  console.log(`Audio file saved: server_response_audio.mulaw`);
  console.log('='.repeat(60));
  process.exit(0);
});

ws.on('error', (error) => {
  console.error('\n✗ Connection error:', error.message);
  console.error('Make sure the server is running!');
  process.exit(1);
});

// Keep connection open for 30 seconds
setTimeout(() => {
  console.log('\n⏱️ Test timeout - closing connection');
  ws.close();
}, 30000);