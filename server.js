/**
 * Node Live Text-to-Speech Starter - Backend Server
 *
 * Simple WebSocket proxy to Deepgram's Live TTS API.
 * Forwards all messages (JSON and binary) bidirectionally between client and Deepgram.
 */

import { WebSocketServer, WebSocket } from 'ws';
import express from 'express';
import { createServer } from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import toml from 'toml';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  deepgramTtsUrl: 'wss://api.deepgram.com/v1/speak',
  port: process.env.PORT || 8080,
  host: process.env.HOST || '0.0.0.0',
  vitePort: process.env.VITE_PORT || 8081,
  isDevelopment: process.env.NODE_ENV === 'development',
};

// Validate required environment variables
if (!CONFIG.deepgramApiKey) {
  console.error('Error: DEEPGRAM_API_KEY not found in environment variables');
  process.exit(1);
}

// Initialize Express
const app = express();
app.use(express.json());

// ============================================================================
// API ROUTES
// ============================================================================

// Metadata endpoint - required for standardization compliance
app.get('/api/metadata', (req, res) => {
  res.json({
    name: "Node Live Text-to-Speech Starter",
    feature: "live-text-to-speech",
    language: "JavaScript",
    framework: "Node",
    version: "1.0.0"
  });
});

// Create HTTP server
const server = createServer(app);

// ============================================================================
// FRONTEND SERVING (Development vs Production)
// ============================================================================

// Store viteProxy for WebSocket upgrade handling in dev mode
let viteProxy = null;

if (CONFIG.isDevelopment) {
  console.log(`Development mode: Proxying to Vite dev server on port ${CONFIG.vitePort}`);

  // Create proxy middleware for HTTP requests only (no WebSocket)
  viteProxy = createProxyMiddleware({
    target: `http://localhost:${CONFIG.vitePort}`,
    changeOrigin: true,
    ws: false, // Disable automatic WebSocket proxying - we'll handle it manually
  });

  app.use('/', viteProxy);

  // Manually handle WebSocket upgrades at the server level
  // This allows us to selectively proxy based on path
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;

    console.log(`WebSocket upgrade request for: ${pathname}`);

    // Backend handles /tts/stream WebSocket connections directly
    if (pathname === '/tts/stream') {
      console.log('Backend handling /tts/stream WebSocket');
      // Don't do anything - let the WebSocketServer handle it
      return;
    }

    // Forward all other WebSocket connections (Vite HMR) to Vite
    console.log('Proxying WebSocket to Vite');
    viteProxy.upgrade(request, socket, head);
  });
} else {
  console.log('Production mode: Serving static files from frontend/dist');
  const distPath = path.join(__dirname, 'frontend', 'dist');
  app.use(express.static(distPath));
}

// Create WebSocket server for TTS endpoint
const wss = new WebSocketServer({
  server,
  path: '/tts/stream'
});

// Handle WebSocket connections - simple pass-through proxy
wss.on('connection', async (clientWs, request) => {
  console.log('Client connected to /tts/stream');

  try {
    // Parse query parameters from the WebSocket URL
    const url = new URL(request.url, `http://${request.headers.host}`);
    const model = url.searchParams.get('model') || 'aura-asteria-en';
    const encoding = url.searchParams.get('encoding') || 'linear16';
    const sampleRate = url.searchParams.get('sample_rate') || '48000';
    const container = url.searchParams.get('container') || 'none';

    // Build Deepgram WebSocket URL with query parameters
    const deepgramUrl = new URL(CONFIG.deepgramTtsUrl);
    deepgramUrl.searchParams.set('model', model);
    deepgramUrl.searchParams.set('encoding', encoding);
    deepgramUrl.searchParams.set('sample_rate', sampleRate);
    deepgramUrl.searchParams.set('container', container);

    console.log(`Connecting to Deepgram TTS: model=${model}, encoding=${encoding}, sample_rate=${sampleRate}`);

    // Create raw WebSocket connection to Deepgram TTS API
    const deepgramWs = new WebSocket(deepgramUrl.toString(), {
      headers: {
        'Authorization': `Token ${CONFIG.deepgramApiKey}`
      }
    });

    // Forward all messages from Deepgram to client
    deepgramWs.on('open', () => {
      console.log('✓ Connected to Deepgram TTS API');
    });

    deepgramWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    deepgramWs.on('error', (error) => {
      console.error('Deepgram WebSocket error:', error);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'Error',
          description: error.message || 'Deepgram connection error',
          code: 'PROVIDER_ERROR'
        }));
      }
    });

    deepgramWs.on('close', (code, reason) => {
      console.log(`Deepgram connection closed: ${code} ${reason}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        const reservedCodes = [1004, 1005, 1006, 1015];
        const closeCode = (typeof code === 'number' && code >= 1000 && code <= 4999 && !reservedCodes.includes(code)) ? code : 1000;
        clientWs.close(closeCode, reason);
      }
    });

    // Forward all messages from client to Deepgram
    clientWs.on('message', (data, isBinary) => {
      if (deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(data, { binary: isBinary });
      }
    });

    // Handle client disconnect
    clientWs.on('close', (code, reason) => {
      console.log(`Client disconnected: ${code} ${reason}`);
      if (deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.close();
      }
    });

    // Handle client errors
    clientWs.on('error', (error) => {
      console.error('Client WebSocket error:', error);
      if (deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.close();
      }
    });

  } catch (error) {
    console.error('Error setting up proxy:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'Error',
        description: 'Failed to establish proxy connection',
        code: 'CONNECTION_FAILED'
      }));
      clientWs.close();
    }
  }
});

// Start server
server.listen(CONFIG.port, CONFIG.host, () => {
  console.log('');
  console.log('======================================================================');
  console.log(`🚀 Live TTS Backend Server running at http://localhost:${CONFIG.port}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${CONFIG.port}/tts/stream`);
  if (CONFIG.isDevelopment) {
    console.log(`📡 Proxying frontend from Vite dev server on port ${CONFIG.vitePort}`);
  }
  console.log('');
  console.log(`⚠️  Open your browser to http://localhost:${CONFIG.port}`);
  console.log('======================================================================');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received. Closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
