import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { createClient, LiveTTSEvents } from '@deepgram/sdk';
import { createProxyMiddleware } from 'http-proxy-middleware';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
dotenv.config();

// ES module equivalents for __dirname (needed for serving static files)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Application configuration
const CONFIG = {
  port: process.env.PORT || 3000,
  host: process.env.HOST || '0.0.0.0',
  vitePort: 8081, // Must match vite.config.js port
  isDevelopment: process.env.NODE_ENV === 'development',
};

/**
 * Validates that the Deepgram API key is present and not a placeholder
 */
function validateApiKey() {
  const apiKey = process.env.DEEPGRAM_API_KEY;

  if (!apiKey) {
    console.error('\n ERROR: Deepgram API key not found!\n');
    console.error('Please set your API key in .env file:');
    console.error('   DEEPGRAM_API_KEY=your_api_key_here\n');
    console.error('Get your API key at: https://console.deepgram.com\n');
    process.exit(1);
  }

  return apiKey.trim();
}

const DEEPGRAM_API_KEY = validateApiKey();

// Express and WebSocket server setup
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Track active WebSocket connections for graceful shutdown
const activeConnections = new Set();

/**
 * Handles WebSocket upgrade requests
 */
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  // Only handle upgrades for our TTS endpoint
  if (url.pathname === '/live-tts/stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    // Reject upgrade requests to other paths
    socket.destroy();
  }
});


/**
 * Main WebSocket connection handler for /live-tts/stream
 */
wss.on('connection', (clientWs, request) => {
  console.log('New WebSocket connection established');

  // Track this connection for cleanup
  activeConnections.add(clientWs);

  // Parse query parameters from the WebSocket URL
  const url = new URL(request.url, `http://${request.headers.host}`);
  const model = url.searchParams.get('model') || 'aura-asteria-en';

  console.log(`Using TTS model: ${model}`);

  // Initialize Deepgram SDK client
  const deepgram = createClient(DEEPGRAM_API_KEY);
  let deepgramConnection = null;
  let isConnectionReady = false;  // Track if Deepgram connection is open and ready

  // Try-catch: Create Deepgram connection
  // This catches errors during connection setup (bad model, API key issues, etc.)
  try {
    deepgramConnection = deepgram.speak.live({
      model: model,
      encoding: 'linear16',
      sample_rate: 48000,
    });
  } catch (error) {
    console.error('Error creating Deepgram connection:', error);

    // Determine error code based on error type
    let errorCode = 'CONNECTION_FAILED';
    let errorMessage = 'Failed to establish connection to Deepgram';

    if (error.message?.includes('model')) {
      errorCode = 'MODEL_NOT_FOUND';
      errorMessage = `Invalid model: ${model}. Please check the model name.`;
    } else if (error.message?.includes('auth') || error.message?.includes('key')) {
      errorCode = 'CONNECTION_FAILED';
      errorMessage = 'Authentication failed. Please check your API key.';
    }

    const errorResponse = {
      type: 'Error',
      error: {
        type: 'ConnectionError',
        code: errorCode,
        message: errorMessage,
        details: {
          reason: error.message,
          hint: errorCode === 'CONNECTION_FAILED'
            ? 'Verify DEEPGRAM_API_KEY is set correctly in .env'
            : 'Check available models at https://developers.deepgram.com/docs/tts-models'
        }
      }
    };

    clientWs.send(JSON.stringify(errorResponse));
    clientWs.close(1011, 'Deepgram connection failed');
    activeConnections.delete(clientWs);
    return;
  }

  /**
   * Handle the 'Open' event from Deepgram
   * This fires when our connection to Deepgram's API is successfully established
   */

  deepgramConnection.on(LiveTTSEvents.Open, () => {
    console.log('Deepgram TTS connection opened');
    isConnectionReady = true;  // Mark connection as ready

    // Notify the client that we're ready to receive text
    clientWs.send(JSON.stringify({
      type: 'Open',
      message: 'Connected to Deepgram TTS'
    }));
  });

  /**
   * Handle 'Metadata' events from Deepgram
   * This contains information about the TTS request and model being used
   */
  deepgramConnection.on(LiveTTSEvents.Metadata, (data) => {
    console.log('Received metadata from Deepgram');

    const metadataMessage = {
      type: 'Metadata',
      request_id: data.request_id,
      model_name: data.model_name,
      model_version: data.model_version,
      model_uuid: data.model_uuid,
    };
    clientWs.send(JSON.stringify(metadataMessage));
  });

  /**
   * Handle 'Audio' events from Deepgram
   * These are the actual audio chunks being generated from text
   */
  deepgramConnection.on(LiveTTSEvents.Audio, (audioData) => {
    console.log(`Received audio chunk: ${audioData.length} bytes`);

    // Send the raw binary audio data directly to the client
    // No JSON wrapping - just send the Buffer as-is
    if (clientWs.readyState === clientWs.OPEN) {
      clientWs.send(audioData);
    }
  });

  /**
   * Catch-all handler for unhandled events
   * Handles special messages like 'Cleared' that don't have dedicated events
   */
  deepgramConnection.on(LiveTTSEvents.Unhandled, (data) => {
    console.log('Unhandled event:', data);

    // Handle Cleared message from Clear command
    if (data.type === 'Cleared') {
      console.log('Deepgram buffer cleared, sequence_id:', data.sequence_id);
      clientWs.send(JSON.stringify({
        type: 'Cleared',
        sequence_id: data.sequence_id
      }));
    }
  });

  /**
   * Handle 'Flushed' events from Deepgram
   * This indicates that Deepgram has processed all text in its buffer
   * and sent all corresponding audio chunks
   */
  deepgramConnection.on(LiveTTSEvents.Flushed, () => {
    console.log('Deepgram flushed all audio');

    clientWs.send(JSON.stringify({
      type: 'Flushed',
      message: 'All audio chunks sent'
    }));
  });

  /**
   * Handle 'Close' events from Deepgram
   * This fires when Deepgram closes the connection (either normally or due to error)
   */
  deepgramConnection.on(LiveTTSEvents.Close, () => {
    console.log('Deepgram connection closed');
    isConnectionReady = false;  // Mark connection as no longer ready

    clientWs.send(JSON.stringify({
      type: 'Close',
      message: 'Deepgram connection closed'
    }));
  });

  /**
   * Handle 'Error' events from Deepgram
  */
  deepgramConnection.on(LiveTTSEvents.Error, (error) => {
    console.error('Deepgram error:', error);

    const errorMessage = {
      type: 'Error',
      error: {
        type: 'TTS_ERROR',
        code: 'AUDIO_GENERATION_ERROR',
        message: error.message || 'Unknown error occurred'
      }
    };
    clientWs.send(JSON.stringify(errorMessage));

    // Close the WebSocket with error code 1011 (server error)
    clientWs.close(1011, 'Server error');
  });

  /**
   * Handle incoming messages from the client like Speak, Flush, Clear, and Close
   */
  clientWs.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('Received message from client:', data.type);

      /**
       * Handle "Speak" message - client sends text, forward it to Deepgram for TTS generation
       */
      if (data.type === 'Speak') {
        // Validate that text is present (required by contract)
        if (!data.text || typeof data.text !== 'string') {
          const errorMessage = {
            type: 'Error',
            error: {
              type: 'VALIDATION_ERROR',
              code: 'INVALID_TEXT',
              message: 'Text field is required and must be a non-empty string'
            }
          };
          clientWs.send(JSON.stringify(errorMessage));
          return;
        }

        // Check if Deepgram connection is ready before sending text
        if (!isConnectionReady) {
          console.log('Connection not ready yet, waiting...');
          const errorMessage = {
            type: 'Error',
            error: {
              type: 'CONNECTION_ERROR',
              code: 'CONNECTION_FAILED',
              message: 'Deepgram connection is not ready yet. Please wait for the Open event.'
            }
          };
          clientWs.send(JSON.stringify(errorMessage));
          return;
        }

        console.log(`Sending text to Deepgram: "${data.text.substring(0, 50)}..."`);
        deepgramConnection.sendText(data.text);
        deepgramConnection.flush();
        console.log('Waiting for audio chunks from Deepgram...');
      }

      /**
       * Handle "Flush" message
       * Forces Deepgram to process any remaining text in its buffer
       */
      else if (data.type === 'Flush') {
        console.log('Flushing Deepgram buffer');
        deepgramConnection.flush();
      }

      /**
       * Handle "Clear" message
       * Clears Deepgram's internal text buffer (useful for interruptions)
       */
      else if (data.type === 'Clear') {
        console.log('Clearing Deepgram buffer');
        // Note: Check if your SDK version supports clear()
        if (typeof deepgramConnection.clear === 'function') {
          deepgramConnection.clear();
        }
      }

      /**
       * Handle "Close" message
       * Client wants to close the connection
       */
      else if (data.type === 'Close') {
        console.log('Client requested connection close');
        if (deepgramConnection) {
          deepgramConnection.requestClose();
        }
        clientWs.close(1000, 'Normal closure');
      }

      else {
        console.warn('Unknown message type:', data.type);
      }

    } catch (error) {
      console.error('Error parsing client message:', error);

      const errorMessage = {
        type: 'Error',
        error: {
          type: 'PARSING_ERROR',
          code: 'INVALID_TEXT',
          message: 'Failed to parse message: ' + error.message
        }
      };
      clientWs.send(JSON.stringify(errorMessage));
    }
  });

  /**
   * Handle client disconnect
   * Clean up resources when the client closes their connection
   */
  clientWs.on('close', (code, reason) => {
    console.log(`Client disconnected: ${code} - ${reason}`);

    // Clean up Deepgram connection
    if (deepgramConnection) {
      deepgramConnection.requestClose();
      deepgramConnection = null;
    }

    // Remove from active connections
    activeConnections.delete(clientWs);
  });

  /**
   * Handle client errors
   * Catch any WebSocket errors to prevent server crashes
   */
  clientWs.on('error', (error) => {
    console.error('WebSocket error:', error);

    // Clean up
    if (deepgramConnection) {
      deepgramConnection.requestClose();
      deepgramConnection = null;
    }
    activeConnections.delete(clientWs);
  });
});

/**
 * Development mode: Proxy requests to Vite dev server
 * Production mode: Serve static files from frontend/dist
 *
 * This ensures users always access the app at http://localhost:3000
 */
if (CONFIG.isDevelopment) {
  console.log('Development mode: Proxying to Vite dev server');

  // Proxy all requests to Vite (which runs on port 8081)
  app.use(
    createProxyMiddleware({
      target: `http://localhost:${CONFIG.vitePort}`,
      changeOrigin: true,
      ws: true, // Proxy WebSocket connections too
    })
  );
} else {
  console.log('Production mode: Serving static files');

  const distPath = path.join(__dirname, 'frontend', 'dist');
  app.use(express.static(distPath));
}

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log('');
  console.log('');
  console.log(`Server running on: http://localhost:${CONFIG.port}`);
  console.log(`WebSocket endpoint: ws://localhost:${CONFIG.port}/live-tts/stream`);
  console.log(`Environment: ${CONFIG.isDevelopment ? 'development' : 'production'}`);
  console.log('');
  console.log('👉 Open your browser to: http://localhost:3000');
  console.log('');
});


/**
 * Handle shutdown signals (Ctrl+C, Docker stop, etc.)
 * Ensures all WebSocket connections are closed properly
 */
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Close all active WebSocket connections
  activeConnections.forEach(ws => {
    ws.close(1001, 'Server shutting down');
  });

  // Close the HTTP server
  server.close(() => {
    console.log('Server closed successfully');
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
