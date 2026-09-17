/**
 * Node Live Text-to-Speech Starter - Backend Server
 *
 * Bridges a browser WebSocket to Deepgram's Live (streaming) Text-to-Speech
 * API (v1 speak, `wss://api.deepgram.com/v1/speak`) using the official
 * @deepgram/sdk `client.speak.v1` streaming support.
 *
 * The Deepgram side goes through the SDK, which manages the WebSocket, auth,
 * and — critically — binary-audio framing. The browser-facing side is
 * unchanged: the frontend sends JSON control messages (Speak / Flush / Clear / Close)
 * and receives Deepgram's binary audio plus JSON control messages as before.
 *
 * Flow:
 *   browser --(JSON control: Speak/Flush/Clear/Close)--> backend --(SDK)--> Deepgram
 *   browser <--(binary audio + JSON control)------ backend <--(SDK)-- Deepgram
 *
 * Routes:
 *   GET  /api/session                - Issue JWT session token
 *   GET  /api/metadata               - Project metadata from deepgram.toml
 *   WS   /api/live-text-to-speech    - WebSocket bridge to Deepgram TTS (auth required)
 */

const { WebSocketServer, WebSocket } = require('ws');
const express = require('express');
const { createServer } = require('http');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const toml = require('toml');
const { DeepgramClient } = require('@deepgram/sdk');

// Validate required environment variables
if (!process.env.DEEPGRAM_API_KEY) {
  console.error('ERROR: DEEPGRAM_API_KEY environment variable is required');
  console.error('Please copy sample.env to .env and add your API key');
  process.exit(1);
}

// Configuration
const CONFIG = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  port: process.env.PORT || 8081,
  host: process.env.HOST || '0.0.0.0',
};

// A single SDK client is reused across connections; auth is resolved from the
// API key here, so the browser never sees it.
//
// DEEPGRAM_BASE_URL (e.g. a staging host like wss://api.staging.deepgram.com)
// overrides the default production endpoint. speak.v1 uses `environment.production`
// for the /v1/speak websocket, so we set that plus the REST `base`.
const baseUrl = process.env.DEEPGRAM_BASE_URL;
const deepgram = new DeepgramClient({
  apiKey: CONFIG.deepgramApiKey,
  ...(baseUrl
    ? {
        environment: {
          base: baseUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://'),
          production: baseUrl,
          agent: baseUrl,
        },
      }
    : {}),
});
if (baseUrl) {
  console.log(`Using custom Deepgram base URL: ${baseUrl}`);
}

// ============================================================================
// SESSION AUTH - JWT tokens for production security
// ============================================================================

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const JWT_EXPIRY = '1h';

/**
 * Validates JWT from WebSocket subprotocol: access_token.<jwt>
 * Returns the token string if valid, null if invalid.
 */
function validateWsToken(protocols) {
  if (!protocols) return null;
  const list = Array.isArray(protocols) ? protocols : protocols.split(',').map(s => s.trim());
  const tokenProto = list.find(p => p.startsWith('access_token.'));
  if (!tokenProto) return null;
  const token = tokenProto.slice('access_token.'.length);
  try {
    jwt.verify(token, SESSION_SECRET);
    return tokenProto;
  } catch {
    return null;
  }
}

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    // Accept the access_token.* subprotocol so the client sees it echoed back
    for (const proto of protocols) {
      if (proto.startsWith('access_token.')) return proto;
    }
    return false;
  },
});

// Track all active WebSocket connections for graceful shutdown
const activeConnections = new Set();

// Enable CORS
app.use(cors());

// ============================================================================
// SESSION ROUTES - Auth endpoints (unprotected)
// ============================================================================

/**
 * GET /api/session — Issues a signed JWT for session authentication.
 */
app.get('/api/session', (req, res) => {
  const token = jwt.sign(
    { iat: Math.floor(Date.now() / 1000) },
    SESSION_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
  res.json({ token });
});

// ============================================================================
// API ROUTES
// ============================================================================

/**
 * Metadata endpoint - required for standardization compliance
 */
app.get('/api/metadata', (req, res) => {
  try {
    const tomlPath = path.join(__dirname, 'deepgram.toml');
    const tomlContent = fs.readFileSync(tomlPath, 'utf-8');
    const config = toml.parse(tomlContent);

    if (!config.meta) {
      return res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Missing [meta] section in deepgram.toml'
      });
    }

    res.json(config.meta);
  } catch (error) {
    console.error('Error reading metadata:', error);
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to read metadata from deepgram.toml'
    });
  }
});

/**
 * Forward a single Deepgram message to the browser.
 * Binary audio frames go out as binary; parsed control objects as JSON text.
 */
async function forwardToBrowser(clientWs, data) {
  if (clientWs.readyState !== WebSocket.OPEN) return;

  if (data instanceof ArrayBuffer) {
    clientWs.send(Buffer.from(data), { binary: true });
  } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
    // The SDK's Node socket delivers binary as a Blob; convert for `ws`.
    clientWs.send(Buffer.from(await data.arrayBuffer()), { binary: true });
  } else if (Buffer.isBuffer(data)) {
    clientWs.send(data, { binary: true });
  } else if (typeof data === 'string') {
    // Raw string (e.g. a control frame that failed JSON parsing) — pass through.
    clientWs.send(data);
  } else {
    // Parsed control message (Metadata / Flushed / Cleared / Warning / ...)
    clientWs.send(JSON.stringify(data));
  }
}

/**
 * WebSocket bridge handler — one Deepgram TTS connection per browser client.
 * Browser JSON control messages are forwarded to Deepgram via the SDK;
 * Deepgram's binary audio and JSON messages are forwarded back to the browser.
 */
wss.on('connection', async (clientWs, request) => {
  console.log('Client connected to /api/live-text-to-speech');
  activeConnections.add(clientWs);

  // Parse query parameters from the WebSocket URL
  const url = new URL(request.url, `http://${request.headers.host}`);
  const model = url.searchParams.get('model') || 'aura-asteria-en';
  const encoding = url.searchParams.get('encoding') || 'linear16';
  const sampleRateParam = url.searchParams.get('sample_rate');
  const sampleRate = sampleRateParam === null ? 48000 : Number(sampleRateParam);
  const container = url.searchParams.get('container') || 'none';

  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    console.warn(`Rejecting invalid sample_rate: ${sampleRateParam}`);
    clientWs.send(JSON.stringify({
      type: 'Error',
      description: 'sample_rate must be a positive integer',
      code: 'INVALID_REQUEST',
    }));
    clientWs.close(1008, 'Invalid sample_rate');
    activeConnections.delete(clientWs);
    return;
  }

  console.log(`Connecting to Deepgram TTS: model=${model}, encoding=${encoding}, sample_rate=${sampleRate}, container=${container}`);

  // Buffer any browser messages that arrive before the Deepgram socket is open.
  let dgReady = false;
  let dgClosed = false;
  let clientRequestedClose = false;
  let lastDgError = null;
  const pending = [];

  let dgSocket;
  try {
    dgSocket = await deepgram.speak.v1.createConnection({
      model,
      encoding,
      sample_rate: sampleRate,
      queryParams: { container },
      reconnectAttempts: 0,
    });
  } catch (error) {
    const message = error?.message ?? String(error);
    console.error('Failed to create Deepgram connection:', message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'Error',
        description: 'Failed to connect to Deepgram TTS',
        code: 'CONNECTION_FAILED',
      }));
      clientWs.close(1011, 'Deepgram connection failed to open');
    }
    activeConnections.delete(clientWs);
    return;
  }

  // Route a control message (Speak / Flush / Clear / Close) from the browser to the
  // matching SDK method.
  function dispatchToDeepgram(msg) {
    try {
      switch (msg.type) {
        case 'Speak':
          dgSocket.sendText({ type: 'Speak', text: msg.text });
          break;
        case 'Flush':
          dgSocket.sendFlush({ type: 'Flush' });
          break;
        case 'Clear':
          dgSocket.sendClear({ type: 'Clear' });
          break;
        case 'Close':
          dgSocket.sendClose({ type: 'Close' });
          break;
        default:
          console.warn('Ignoring unknown client message type:', msg.type);
      }
    } catch (error) {
      console.error('Failed to forward message to Deepgram:', error.message);
    }
  }

  // Deepgram -> browser (binary audio + JSON control)
  //
  // Binary audio arrives from the SDK socket as a Blob and needs an async
  // conversion (`data.arrayBuffer()`) before it can be forwarded, while JSON
  // control frames (Flushed / Cleared / ...) forward synchronously. Firing each
  // forward independently lets a synchronous control frame overtake the still-
  // converting final audio chunk, clipping the audio tail. Serialize every
  // forward through a promise chain so the browser receives frames in the exact
  // order Deepgram sent them.
  let sendChain = Promise.resolve();
  dgSocket.on('message', (data) => {
    sendChain = sendChain
      .then(() => forwardToBrowser(clientWs, data))
      .catch((err) => console.error('Failed to forward Deepgram message:', err));
  });

  dgSocket.on('open', () => {
    console.log('✓ Connected to Deepgram TTS API');
  });

  dgSocket.on('error', (error) => {
    const message = error?.message ?? String(error);
    console.error('Deepgram socket error:', message);
    lastDgError = message;
  });

  dgSocket.on('close', (event) => {
    if (dgClosed) return;
    dgClosed = true;
    console.log('Deepgram connection closed');
    // The SDK emits close before error for failed handshakes and terminal errors.
    // Reading lastDgError in this queued callback lets that later error listener run first.
    sendChain = sendChain.then(() => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      if (!dgReady) {
        clientWs.send(JSON.stringify({
          type: 'Error',
          description: `Failed to connect to Deepgram TTS${lastDgError ? `: ${lastDgError}` : ''}`,
          code: 'CONNECTION_FAILED',
        }));
        clientWs.close(1011, 'Deepgram connection failed to open');
      } else if (!clientRequestedClose && (lastDgError || (typeof event?.code === 'number' && event.code !== 1000))) {
        clientWs.send(JSON.stringify({
          type: 'Error',
          description: lastDgError || 'Deepgram connection closed unexpectedly',
          code: 'PROVIDER_ERROR',
        }));
        clientWs.close(1011, 'Deepgram connection failed');
      } else {
        clientWs.close(1000, 'Deepgram connection closed');
      }
    });
  });

  // browser -> Deepgram (JSON control, buffered until the Deepgram socket is open)
  clientWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn('Ignoring non-JSON message from client');
      return;
    }
    if (msg.type === 'Close') clientRequestedClose = true;
    if (!dgReady) {
      pending.push(msg);
      return;
    }
    dispatchToDeepgram(msg);
  });

  // Handle client disconnect
  clientWs.on('close', (code, reason) => {
    console.log(`Client disconnected: ${code} ${reason}`);
    try {
      dgSocket.close();
    } catch {
      // already closed
    }
    activeConnections.delete(clientWs);
  });

  // Handle client errors
  clientWs.on('error', (error) => {
    console.error('Client WebSocket error:', error?.message ?? error);
    try {
      dgSocket.close();
    } catch {
      // already closed
    }
  });

  // Open the Deepgram connection and flush anything the browser sent early.
  try {
    dgSocket.connect();
    await dgSocket.waitForOpen();
    dgReady = true;
    for (const msg of pending) dispatchToDeepgram(msg);
    pending.length = 0;
  } catch (error) {
    console.error('Deepgram connection did not open:', error?.message ?? error);
  }
});

/**
 * Handle WebSocket upgrade requests for /api/live-text-to-speech.
 * Validates JWT from access_token.<jwt> subprotocol before upgrading.
 */
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;

  console.log(`WebSocket upgrade request for: ${pathname}`);

  if (pathname === '/api/live-text-to-speech') {
    // Validate JWT from subprotocol
    const protocols = request.headers['sec-websocket-protocol'];
    const validProto = validateWsToken(protocols);
    if (!validProto) {
      console.log('WebSocket auth failed: invalid or missing token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    console.log('Backend handling /api/live-text-to-speech WebSocket (authenticated)');
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
    return;
  }

  // Unknown WebSocket path - reject
  console.log(`Unknown WebSocket path: ${pathname}`);
  socket.destroy();
});

/**
 * Graceful shutdown handler
 */
function gracefulShutdown(signal) {
  console.log(`\n${signal} signal received: starting graceful shutdown...`);

  // Stop accepting new connections
  wss.close(() => {
    console.log('WebSocket server closed to new connections');
  });

  // Close all active WebSocket connections
  console.log(`Closing ${activeConnections.size} active WebSocket connection(s)...`);
  activeConnections.forEach((ws) => {
    try {
      ws.close(1001, 'Server shutting down');
    } catch (error) {
      console.error('Error closing WebSocket:', error);
    }
  });

  // Close the HTTP server
  server.close(() => {
    console.log('HTTP server closed');
    console.log('Shutdown complete');
    process.exit(0);
  });

  // Force shutdown after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Start server
server.listen(CONFIG.port, CONFIG.host, () => {
  console.log("\n" + "=".repeat(70));
  console.log(`🚀 Backend API Server running at http://localhost:${CONFIG.port}`);
  console.log("");
  console.log(`📡 GET  /api/session`);
  console.log(`📡 WS   /api/live-text-to-speech (auth required)`);
  console.log(`📡 GET  /api/metadata`);
  console.log("=".repeat(70) + "\n");
});
