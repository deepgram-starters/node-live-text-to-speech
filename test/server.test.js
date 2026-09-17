const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:http');
const test = require('node:test');
const { WebSocket, WebSocketServer } = require('ws');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getAvailablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForServer(url, process) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (process.exitCode !== null) throw new Error('Server exited before becoming ready');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await sleep(50);
  }
  throw new Error('Server did not become ready');
}

async function stop(process) {
  if (process.exitCode !== null) return;
  process.kill('SIGTERM');
  await once(process, 'exit');
}

test('reports an upstream handshake failure before closing without reconnecting', async (t) => {
  let upstreamConnections = 0;
  let upstreamUrl;
  const upstream = createServer();
  upstream.on('upgrade', (request, socket) => {
    upstreamConnections += 1;
    upstreamUrl = new URL(request.url, 'http://localhost');
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  t.after(async () => {
    upstream.close();
    await once(upstream, 'close');
  });

  const appPort = await getAvailablePort();
  const app = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEEPGRAM_API_KEY: 'test-key',
      DEEPGRAM_BASE_URL: `ws://127.0.0.1:${upstreamPort}`,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      SESSION_SECRET: 'test-session-secret',
    },
    stdio: 'ignore',
  });
  t.after(() => stop(app));
  await waitForServer(`http://127.0.0.1:${appPort}/api/metadata`, app);

  const { token } = await (await fetch(`http://127.0.0.1:${appPort}/api/session`)).json();
  const client = new WebSocket(
    `ws://127.0.0.1:${appPort}/api/live-text-to-speech?sample_rate=24000`,
    `access_token.${token}`
  );
  const result = await new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => reject(new Error('Timed out waiting for upstream failure')), 3000);
    client.on('message', message => messages.push(JSON.parse(message)));
    client.on('error', reject);
    client.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, messages, reason: reason.toString() });
    });
  });

  await sleep(1500);
  assert.equal(upstreamConnections, 1);
  assert.equal(upstreamUrl.pathname, '/v1/speak');
  assert.equal(upstreamUrl.searchParams.get('sample_rate'), '24000');
  assert.equal(upstreamUrl.searchParams.get('container'), 'none');
  assert.equal(result.code, 1011);
  assert.deepEqual(result.messages, [{
    type: 'Error',
    description: 'Failed to connect to Deepgram TTS: Unexpected server response: 401',
    code: 'CONNECTION_FAILED',
  }]);
  assert.doesNotMatch(JSON.stringify(result.messages), /test-key/);
});

test('rejects an invalid sample rate before connecting upstream', async (t) => {
  let upstreamConnections = 0;
  const upstream = createServer();
  upstream.on('upgrade', () => {
    upstreamConnections += 1;
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  t.after(async () => {
    upstream.close();
    await once(upstream, 'close');
  });

  const appPort = await getAvailablePort();
  const app = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEEPGRAM_API_KEY: 'test-key',
      DEEPGRAM_BASE_URL: `ws://127.0.0.1:${upstreamPort}`,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      SESSION_SECRET: 'test-session-secret',
    },
    stdio: 'ignore',
  });
  t.after(() => stop(app));
  await waitForServer(`http://127.0.0.1:${appPort}/api/metadata`, app);

  const { token } = await (await fetch(`http://127.0.0.1:${appPort}/api/session`)).json();
  const client = new WebSocket(
    `ws://127.0.0.1:${appPort}/api/live-text-to-speech?sample_rate=not-a-number`,
    `access_token.${token}`
  );
  const result = await new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => reject(new Error('Timed out waiting for invalid request')), 3000);
    client.on('message', message => messages.push(JSON.parse(message)));
    client.on('error', reject);
    client.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, messages });
    });
  });

  assert.equal(upstreamConnections, 0);
  assert.equal(result.code, 1008);
  assert.deepEqual(result.messages, [{
    type: 'Error',
    description: 'sample_rate must be a positive integer',
    code: 'INVALID_REQUEST',
  }]);
});

test('reports an unexpected post-open upstream close before closing', async (t) => {
  const upstream = createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (request, socket, head) => {
    upstreamWss.handleUpgrade(request, socket, head, (ws) => {
      upstreamWss.emit('connection', ws, request);
    });
  });
  upstreamWss.on('connection', (socket) => {
    setTimeout(() => socket.close(1011, 'upstream failed'), 100);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  t.after(async () => {
    upstreamWss.close();
    upstream.close();
    await once(upstream, 'close');
  });

  const appPort = await getAvailablePort();
  const app = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEEPGRAM_API_KEY: 'test-key',
      DEEPGRAM_BASE_URL: `ws://127.0.0.1:${upstreamPort}`,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      SESSION_SECRET: 'test-session-secret',
    },
    stdio: 'ignore',
  });
  t.after(() => stop(app));
  await waitForServer(`http://127.0.0.1:${appPort}/api/metadata`, app);

  const { token } = await (await fetch(`http://127.0.0.1:${appPort}/api/session`)).json();
  const client = new WebSocket(
    `ws://127.0.0.1:${appPort}/api/live-text-to-speech`,
    `access_token.${token}`
  );
  const result = await new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => reject(new Error('Timed out waiting for upstream close')), 3000);
    client.on('message', message => messages.push(JSON.parse(message)));
    client.on('error', reject);
    client.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, messages });
    });
  });

  assert.equal(result.code, 1011);
  assert.deepEqual(result.messages, [{
    type: 'Error',
    description: 'Deepgram connection closed unexpectedly',
    code: 'PROVIDER_ERROR',
  }]);
});

test('preserves a normal close after the browser sends Close', async (t) => {
  const upstream = createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (request, socket, head) => {
    upstreamWss.handleUpgrade(request, socket, head, (ws) => {
      upstreamWss.emit('connection', ws, request);
    });
  });
  upstreamWss.on('connection', (socket) => {
    socket.on('message', (message) => {
      if (JSON.parse(message).type === 'Close') socket.close(1000, 'closed');
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  t.after(async () => {
    upstreamWss.close();
    upstream.close();
    await once(upstream, 'close');
  });

  const appPort = await getAvailablePort();
  const app = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEEPGRAM_API_KEY: 'test-key',
      DEEPGRAM_BASE_URL: `ws://127.0.0.1:${upstreamPort}`,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      SESSION_SECRET: 'test-session-secret',
    },
    stdio: 'ignore',
  });
  t.after(() => stop(app));
  await waitForServer(`http://127.0.0.1:${appPort}/api/metadata`, app);

  const { token } = await (await fetch(`http://127.0.0.1:${appPort}/api/session`)).json();
  const client = new WebSocket(
    `ws://127.0.0.1:${appPort}/api/live-text-to-speech`,
    `access_token.${token}`
  );
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for normal close')), 3000);
    client.on('open', () => client.send(JSON.stringify({ type: 'Close' })));
    client.on('error', reject);
    client.on('close', (closeCode) => {
      clearTimeout(timer);
      resolve(closeCode);
    });
  });

  assert.equal(code, 1000);
});

test('forwards all burst audio before Flushed', async (t) => {
  const upstream = createServer();
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (request, socket, head) => {
    upstreamWss.handleUpgrade(request, socket, head, (ws) => {
      upstreamWss.emit('connection', ws, request);
    });
  });
  upstreamWss.on('connection', (socket) => {
    // Send the frames synchronously so Blob conversions race the control frame.
    for (let index = 0; index < 8; index += 1) {
      socket.send(Buffer.from([index]));
    }
    socket.send(JSON.stringify({ type: 'Flushed' }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  t.after(async () => {
    upstreamWss.close();
    upstream.close();
    await once(upstream, 'close');
  });

  const appPort = await getAvailablePort();
  const app = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEEPGRAM_API_KEY: 'test-key',
      DEEPGRAM_BASE_URL: `ws://127.0.0.1:${upstreamPort}`,
      HOST: '127.0.0.1',
      PORT: String(appPort),
      SESSION_SECRET: 'test-session-secret',
    },
    stdio: 'ignore',
  });
  t.after(() => stop(app));
  await waitForServer(`http://127.0.0.1:${appPort}/api/metadata`, app);

  const { token } = await (await fetch(`http://127.0.0.1:${appPort}/api/session`)).json();
  const client = new WebSocket(
    `ws://127.0.0.1:${appPort}/api/live-text-to-speech`,
    `access_token.${token}`
  );
  const messages = await new Promise((resolve, reject) => {
    const received = [];
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Flushed')), 3000);
    client.on('message', (data, isBinary) => {
      const type = isBinary ? 'audio' : JSON.parse(data).type;
      received.push(type);
      if (type === 'Flushed') {
        setTimeout(() => {
          clearTimeout(timer);
          client.close();
          resolve(received);
        }, 100);
      }
    });
    client.on('error', reject);
  });

  assert.equal(messages.filter(message => message === 'audio').length, 8);
  assert.equal(messages.at(-1), 'Flushed');
  assert.equal(messages.slice(messages.indexOf('Flushed') + 1).includes('audio'), false);
});
