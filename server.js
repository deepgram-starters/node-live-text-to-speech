// index.js
const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const { createClient, LiveTTSEvents } = require('@deepgram/sdk');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Replace with your actual Deepgram API key in the .env file
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;

// WAV header to be sent once per text message
const wavHeader = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x00, 0x00, 0x00, 0x00, // Placeholder for file size
  0x57, 0x41, 0x56, 0x45, // "WAVE"
  0x66, 0x6D, 0x74, 0x20, // "fmt "
  0x10, 0x00, 0x00, 0x00, // Chunk size (16)
  0x01, 0x00,             // Audio format (1 for PCM)
  0x01, 0x00,             // Number of channels (1)
  0x80, 0xBB, 0x00, 0x00, // Sample rate (48000)
  0x00, 0xEE, 0x02, 0x00, // Byte rate (48000 * 2)
  0x02, 0x00,             // Block align (2)
  0x10, 0x00,             // Bits per sample (16)
  0x64, 0x61, 0x74, 0x61, // "data"
  0x00, 0x00, 0x00, 0x00  // Placeholder for data size
]);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Start the Express server
const server = app.listen(port, () => {
  console.log(`Express server listening on port ${port}`);
});

// Create the WebSocket server
const wss = new WebSocket.Server({ server });

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Instantiate Deepgram SDK
  const deepgram = createClient(deepgramApiKey);

  let dgSocket; // Placeholder for Deepgram socket
  let lastSent = new Date(Date.now() - 5000); // Current time minus 5 seconds

  ws.on('message', async (message) => {
    console.log(`Received message: ${message}`);

    try {
      const data = JSON.parse(message);
      const text = data.text;
      const model = data.model || 'aura-2-thalia-en';

      if (!text) {
        console.log('No text provided');
        return;
      }

      // Check if we already have a Deepgram socket
      if (!dgSocket) {
        // Start the TTS connection
        dgSocket = deepgram.speak.live({
          model: model,
          encoding: 'linear16',
          sample_rate: 48000,
        });

        // Set up event listeners
        dgSocket.on(LiveTTSEvents.Open, () => {
          console.log('Deepgram TTS WebSocket opened');

          // Send 'Open' message to client
          ws.send(JSON.stringify({ type: 'Open' }));

          // Send the text to Deepgram TTS
          dgSocket.sendText(text);
          dgSocket.flush();
        });

        dgSocket.on(LiveTTSEvents.Audio, (data) => {
          if (lastSent < Date.now() - 3000) {
            console.log('Sending WAV header');
            ws.send(wavHeader);
            lastSent = Date.now()
          }

          // Send audio data to client
          console.log('Received audio data from Deepgram');
          ws.send(data);
        });

        dgSocket.on(LiveTTSEvents.Flushed, () => {
          console.log('Deepgram TTS Flushed');
          // Send 'Flushed' message to client
          ws.send(JSON.stringify({ type: 'Flushed' }));
        });

        dgSocket.on(LiveTTSEvents.Close, () => {
          console.log('Deepgram TTS WebSocket closed');
          // Send 'Close' message to client
          ws.send(JSON.stringify({ type: 'Close' }));
          dgSocket = null;
        });

        dgSocket.on(LiveTTSEvents.Error, (error) => {
          console.error('Deepgram TTS WebSocket error:', error);
          // Send 'Error' message to client
          ws.send(JSON.stringify({ type: 'Error', error: error.message }));
        });
      } else {
        // If the Deepgram socket already exists, send the text
        dgSocket.sendText(text);
        dgSocket.flush();
      }

    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({ type: 'Error', error: error.message }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (dgSocket) {
      dgSocket.requestClose();
      dgSocket = null;
    }
  });
});
