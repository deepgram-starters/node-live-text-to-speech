/**
 * Node Live Text-to-Speech Starter - Backend Server
 *
 * Simple WebSocket proxy to Deepgram's Live TTS API.
 * Forwards all messages (JSON and binary) bidirectionally between client and Deepgram.
 *
 * Routes:
 *   GET  /api/session                - Issue JWT session token
 *   GET  /api/metadata               - Project metadata from deepgram.toml
 *   WS   /api/live-text-to-speech    - WebSocket proxy to Deepgram TTS (auth required)
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

// Validate required environment variables
if (!process.env.DEEPGRAM_API_KEY) {
  console.error('ERROR: DEEPGRAM_API_KEY environment variable is required');
  console.error('Please copy sample.env to .env and add your API key');
  process.exit(1);
}

// Configuration
const CONFIG = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  deepgramTtsUrl: 'wss://api.deepgram.com/v1/speak',
  port: process.env.PORT || 8081,
  host: process.env.HOST || '0.0.0.0',
};

// ============================================================================
// SESSION AUTH - JWT tokens with page nonce for production security
// ============================================================================

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const REQUIRE_NONCE = !!process.env.SESSION_SECRET;

const sessionNonces = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000;
const JWT_EXPIRY = '1h';

function generateNonce() {
  const nonce = crypto.randomBytes(16).toString('hex');
  sessionNonces.set(nonce, Date.now() + NONCE_TTL_MS);
  return nonce;
}

function consumeNonce(nonce) {
  const expiry = sessionNonces.get(nonce);
  if (!expiry) return false;
  sessionNonces.delete(nonce);
  return Date.now() < expiry;
}

setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiry] of sessionNonces) {
    if (now >= expiry) sessionNonces.delete(nonce);
  }
}, 60_000);

let indexHtmlTemplate = null;
try {
  indexHtmlTemplate = fs.readFileSync(
    path.join(__dirname, 'frontend', 'dist', 'index.html'),
    'utf-8'
  );
} catch {
  // No built frontend (dev mode)
}

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
 * GET / — Serve index.html with injected session nonce (production only)
 */
app.get('/', (req, res) => {
  if (!indexHtmlTemplate) {
    return res.status(404).send('Frontend not built. Run make build first.');
  }
  const nonce = generateNonce();
  const html = indexHtmlTemplate.replace(
    '</head>',
    `<meta name="session-nonce" content="${nonce}">\n</head>`
  );
  res.type('html').send(html);
});

/**
 * GET /api/session — Issues a JWT. In production, requires valid nonce.
 */
app.get('/api/session', (req, res) => {
  if (REQUIRE_NONCE) {
    const nonce = req.headers['x-session-nonce'];
    if (!nonce || !consumeNonce(nonce)) {
      return res.status(403).json({
        error: {
          type: 'AuthenticationError',
          code: 'INVALID_NONCE',
          message: 'Valid session nonce required. Please refresh the page.',
        },
      });
    }
  }

  const token = jwt.sign({ iat: Math.floor(Date.now() / 1000) }, SESSION_SECRET, {
    expiresIn: JWT_EXPIRY,
  });
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
 * WebSocket proxy handler
 * Forwards all messages bidirectionally between client and Deepgram
 */
wss.on('connection', async (clientWs, request) => {
  console.log('Client connected to /api/live-text-to-speech');
  activeConnections.add(clientWs);

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
      activeConnections.delete(clientWs);
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
  console.log(`📡 GET  /api/session${REQUIRE_NONCE ? ' (nonce required)' : ''}`);
  console.log(`📡 WS   /api/live-text-to-speech (auth required)`);
  console.log(`📡 GET  /api/metadata`);
  console.log("=".repeat(70) + "\n");
});
