const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:http');
const test = require('node:test');
const { WebSocket } = require('ws');

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
