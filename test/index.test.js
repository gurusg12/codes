'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NodeApiWatch = require('../index.js');
const { computeCpuUsage, normalizePath, scrub, RingBuffer } = NodeApiWatch._internals;

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function request(port, p = '/', { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const defaultHandler = (req, res) => {
  if (req.url.startsWith('/boom')) { res.writeHead(500); return res.end('boom'); }
  if (req.url.startsWith('/missing')) { res.writeHead(404); return res.end('nope'); }
  if (req.url.startsWith('/login')) { res.writeHead(401); return res.end('denied'); }
  if (req.url.startsWith('/slow')) return setTimeout(() => { res.writeHead(200); res.end('slow'); }, 40);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end('{"ok":true}');
};

async function withServer(options, fn, handler = defaultHandler, { wrap = false } = {}) {
  const monitor = new NodeApiWatch(options);
  const listener = wrap ? monitor.wrap(handler) : (req, res) => { if (monitor.track(req, res)) handler(req, res); };
  const server = http.createServer(listener);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn({ monitor, port, get: (p, o) => request(port, p, o) });
  } finally {
    await monitor.stop();
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

// ---------------------------------------------------------------------------
test('tracks a successful request with full details', async () => {
  await withServer({}, async ({ monitor, get }) => {
    await get('/api/users?page=2', { headers: { 'User-Agent': 'unit-test', 'Content-Type': 'application/json' } });
    await settle();
    const [rec] = monitor.getRequestLogs();
    assert.strictEqual(rec.method, 'GET');
    assert.strictEqual(rec.path, '/api/users');
    assert.strictEqual(rec.statusCode, 200);
    assert.strictEqual(rec.result, 'SUCCESS');
    assert.strictEqual(rec.userAgent, 'unit-test');
    assert.strictEqual(rec.contentType, 'application/json');
    assert.strictEqual(rec.httpVersion, '1.1');
    assert.deepStrictEqual({ ...rec.query }, { page: '2' });
    assert.ok(rec.duration >= 0);
    assert.ok(rec.responseSize > 0);
    assert.ok(rec.ip);
  });
});

test('tracks failed requests and classifies statuses', async () => {
  await withServer({}, async ({ monitor, get }) => {
    await get('/ok'); await get('/login', { method: 'POST' }); await get('/missing'); await get('/boom');
    await settle();
    const s = monitor.getRequestStats();
    assert.strictEqual(s.total, 4);
    assert.strictEqual(s.successful, 1);
    assert.strictEqual(s.clientErrors, 2);
    assert.strictEqual(s.serverErrors, 1);
    assert.strictEqual(s.successRate, 25);
    assert.strictEqual(s.failureRate, 75);
    assert.strictEqual(s.errorRate, 25);
    const login = monitor.getRequestLogs().find((r) => r.path === '/login');
    assert.strictEqual(login.result, 'FAILED');
    assert.strictEqual(login.method, 'POST');
  });
});

test('redirects are classified separately', async () => {
  await withServer({}, async ({ monitor, get }) => {
    await get('/r');
    await settle();
    assert.strictEqual(monitor.getRequestStats().redirects, 1);
  }, (req, res) => { res.writeHead(302, { Location: '/x' }); res.end(); });
});

test('custom classification is honoured, invalid results fall back to default', async () => {
  await withServer({ classify: (status) => (status === 404 ? 'success' : 'not-a-category') }, async ({ monitor, get }) => {
    await get('/missing'); await get('/boom');
    await settle();
    const s = monitor.getRequestStats();
    assert.strictEqual(s.successful, 1);
    assert.strictEqual(s.serverErrors, 1);
  });
});

test('request IDs: UUID, response header, accessible to the app, configurable', async () => {
  const monitor = new NodeApiWatch();
  const server = http.createServer((req, res) => { monitor.track(req, res); res.end(monitor.getRequestId(req)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await request(server.address().port);
  assert.match(res.headers['x-request-id'], UUID);
  assert.strictEqual(res.body, res.headers['x-request-id']);
  server.closeAllConnections(); server.close();

  await withServer({ requestIdHeader: false }, async ({ get }) => {
    assert.strictEqual((await get('/')).headers['x-request-id'], undefined);
  });
  await withServer({ requestIdHeader: 'X-Trace' }, async ({ get }) => {
    assert.match((await get('/')).headers['x-trace'], UUID);
  });
});

test('incoming request IDs are ignored unless trusted and valid', async () => {
  await withServer({}, async ({ get }) => {
    const r = await get('/', { headers: { 'X-Request-ID': 'attacker-id' } });
    assert.notStrictEqual(r.headers['x-request-id'], 'attacker-id');
  });
  await withServer({ trustIncomingRequestId: true }, async ({ get }) => {
    assert.strictEqual((await get('/', { headers: { 'X-Request-ID': 'abc-123' } })).headers['x-request-id'], 'abc-123');
    assert.match((await get('/', { headers: { 'X-Request-ID': 'bad id\t!' } })).headers['x-request-id'], UUID);
  });
});

test('performance: timing stats, slow requests, slowRequest event', async () => {
  await withServer({ slowRequestThreshold: 20 }, async ({ monitor, get }) => {
    const slow = [];
    monitor.on('slowRequest', (d) => slow.push(d));
    await get('/fast'); await get('/slow');
    await settle();
    const p = monitor.getPerformanceStats();
    assert.strictEqual(p.count, 2);
    assert.ok(p.maximum >= 35, `max was ${p.maximum}`);
    assert.ok(p.minimum <= p.average && p.average <= p.maximum);
    assert.ok(p.p99 >= p.p50);
    assert.strictEqual(p.slowRequests, 1);
    assert.strictEqual(slow.length, 1);
    assert.strictEqual(slow[0].threshold, 20);
  });
});

test('endpoint statistics group by method + normalized path', async () => {
  await withServer({}, async ({ monitor, get }) => {
    await get('/api/users/1'); await get('/api/users/2'); await get('/api/users/3'); await get('/boom');
    await settle();
    const eps = monitor.getEndpointStats();
    const users = eps.find((e) => e.endpoint === 'GET /api/users/:id');
    assert.strictEqual(users.requests, 3);
    assert.strictEqual(users.success, 3);
    const boom = eps.find((e) => e.endpoint === 'GET /boom');
    assert.strictEqual(boom.serverErrors, 1);
    assert.strictEqual(boom.errors, 1);
    assert.ok(typeof users.averageDuration === 'number');
  });
});

test('path normalization collapses ids, uuids and long tokens', () => {
  assert.strictEqual(normalizePath('/a/123/b'), '/a/:id/b');
  assert.strictEqual(normalizePath('/u/123e4567-e89b-12d3-a456-426614174000'), '/u/:uuid');
  assert.strictEqual(normalizePath('/r/abcdef0123456789abcdef'), '/r/:hex');
  assert.strictEqual(normalizePath('/t/Abcdefghijklmnopqrstuvwxyz1'), '/t/:token');
  assert.strictEqual(normalizePath('/plain/path'), '/plain/path');
});

test('error tracking records 4xx/5xx and captured errors (scrubbed)', async () => {
  await withServer({}, async ({ monitor, get }) => {
    await get('/missing'); await get('/boom');
    await settle();
    const errors = monitor.getErrors();
    assert.strictEqual(errors.length, 2);
    const e = errors.find((x) => x.status === 500);
    for (const k of ['timestamp', 'requestId', 'endpoint', 'method', 'status', 'message', 'type', 'duration']) assert.ok(k in e, k);
    assert.strictEqual(e.type, 'ServerError');
    assert.strictEqual(e.message, 'HTTP 500 Internal Server Error');
  });

});

test('captureError attaches application errors to the request (scrubbed)', async () => {
  const monitor = new NodeApiWatch();
  const server = http.createServer((req, res) => {
    monitor.track(req, res);
    monitor.captureError(req, new TypeError('db failed token=abc123'));
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await request(server.address().port, '/x');
  await settle();
  const errs = monitor.getErrors();
  assert.strictEqual(errs.length, 1);
  assert.strictEqual(errs[0].type, 'TypeError');
  assert.ok(!errs[0].message.includes('abc123'));
  server.closeAllConnections(); server.close();
});

test('aborted connections are recorded', async () => {
  const monitor = new NodeApiWatch();
  const server = http.createServer((req, res) => { monitor.track(req, res); /* never answers */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/hang', agent: false });
    req.on('error', () => {});
    req.end();
    setTimeout(() => { req.destroy(); resolve(); }, 50);
  });
  await settle(60);
  assert.strictEqual(monitor.getRequestStats().aborted, 1);
  assert.strictEqual(monitor.getErrors()[0].type, 'Aborted');
  server.closeAllConnections(); server.close();
});

test('rate limiting returns 429, headers, events and stats', async () => {
  await withServer({ rateLimit: { enabled: true, windowMs: 60000, maxRequests: 2 } }, async ({ monitor, get }) => {
    const exceeded = [];
    monitor.on('rateLimitExceeded', (d) => exceeded.push(d));
    const r1 = await get('/a'); const r2 = await get('/a'); const r3 = await get('/a');
    await settle();
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.headers['x-ratelimit-remaining'], '1');
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r3.status, 429);
    assert.ok(Number(r3.headers['retry-after']) >= 1);
    assert.strictEqual(JSON.parse(r3.body).error, 'Too Many Requests');
    const s = monitor.getRateLimitStats();
    assert.strictEqual(s.limited, 1);
    assert.strictEqual(s.allowed, 2);
    assert.strictEqual(exceeded.length, 1);
    assert.strictEqual(monitor.getRequestStats().clientErrors, 1); // 429 is recorded
  });
});

test('rate limit supports observe-only mode, ip+endpoint and custom keys', async () => {
  await withServer({ rateLimit: { maxRequests: 1, enforce: false } }, async ({ monitor, get }) => {
    await get('/a'); const r = await get('/a');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(monitor.getRateLimitStats().limited, 1);
  });
  await withServer({ rateLimit: { maxRequests: 1, keyBy: 'ip+endpoint' } }, async ({ get }) => {
    assert.strictEqual((await get('/a')).status, 200);
    assert.strictEqual((await get('/b')).status, 200); // different endpoint => different bucket
    assert.strictEqual((await get('/a')).status, 429);
  });
  await withServer({ rateLimit: { maxRequests: 1, keyBy: (req) => req.headers['x-user'] || null } }, async ({ get }) => {
    assert.strictEqual((await get('/', { headers: { 'x-user': 'u1' } })).status, 200);
    assert.strictEqual((await get('/', { headers: { 'x-user': 'u2' } })).status, 200);
    assert.strictEqual((await get('/', { headers: { 'x-user': 'u1' } })).status, 429);
    assert.strictEqual((await get('/')).status, 200); // null key => not limited
    assert.strictEqual((await get('/')).status, 200);
  });
});

test('duplicate request detection flags repeated requests without blocking', async () => {
  await withServer({ duplicateDetection: { threshold: 3, windowMs: 5000 } }, async ({ monitor, get }) => {
    for (let i = 0; i < 4; i++) assert.strictEqual((await get('/api/products')).status, 200);
    await get('/api/other');
    const dups = monitor.getRepeatedRequests();
    assert.strictEqual(dups.length, 1);
    assert.strictEqual(dups[0].endpoint, 'GET /api/products');
    assert.ok(dups[0].count >= 3);
    assert.strictEqual(dups[0].window, 5000);
  });
});

test('CPU usage calculation uses deltas between samples', () => {
  assert.strictEqual(computeCpuUsage({ idle: 100, total: 200 }, { idle: 150, total: 300 }), 50);
  assert.strictEqual(computeCpuUsage({ idle: 0, total: 0 }, { idle: 100, total: 100 }), 0);
  assert.strictEqual(computeCpuUsage({ idle: 10, total: 100 }, { idle: 10, total: 100 }), null);
  const cpu = new NodeApiWatch().getCpuUsage();
  assert.ok(cpu.systemPercent === null || (cpu.systemPercent >= 0 && cpu.systemPercent <= 100));
});

test('system stats expose cpu, memory, process and runtime info', async () => {
  const m = new NodeApiWatch();
  const s = m.getSystemStats();
  assert.ok(s.cpu.count >= 1);
  assert.ok(s.memory.total >= s.memory.free && s.memory.used === s.memory.total - s.memory.free);
  for (const k of ['rss', 'heapUsed', 'heapTotal', 'external', 'heapLimit']) assert.ok(s.memory[k] > 0, k);
  assert.strictEqual(s.process.pid, process.pid);
  assert.strictEqual(s.runtime.nodeVersion, process.version);
  assert.strictEqual(s.runtime.platform, process.platform);
  assert.ok(s.runtime.systemUptime > 0);
});

test('health reports checks and a status', async () => {
  await withServer({ healthMinRequests: 2, errorRateThreshold: 50, cpuThreshold: 100, memoryThreshold: 100 }, async ({ monitor, get }) => {
    await get('/boom'); await get('/boom'); await get('/ok');
    await settle();
    const h = monitor.health();
    const er = h.checks.find((c) => c.name === 'errorRate');
    assert.strictEqual(er.status, 'fail');
    assert.ok(['degraded', 'unhealthy'].includes(h.status));
    assert.ok(h.definition.includes('healthy'));
  });
  const fresh = new NodeApiWatch({ cpuThreshold: 100, memoryThreshold: 100 }).health();
  assert.strictEqual(fresh.checks.find((c) => c.name === 'errorRate').status, 'unknown');
  assert.strictEqual(fresh.status, 'healthy');
});

test('reports: structure, JSON export, file save, reportGenerated event', async () => {
  await withServer({}, async ({ monitor, get }) => {
    await get('/api/x');
    await settle();
    let emitted = 0;
    monitor.on('reportGenerated', () => emitted++);
    const report = monitor.getReport();
    for (const k of ['generatedAt', 'requests', 'performance', 'endpoints', 'errors', 'rateLimit', 'system', 'runtime']) assert.ok(k in report, k);
    assert.strictEqual(report.requests.total, 1);
    const parsed = JSON.parse(monitor.exportReport());
    assert.strictEqual(parsed.requests.total, 1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-'));
    const file = await monitor.saveReport(path.join(dir, 'sub', 'report.json'));
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).requests.total, 1);
    assert.strictEqual(emitted, 3);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('data retention: bounded buffers, endpoint cap, time-based cleanup', async () => {
  await withServer({ maxStoredRequests: 3, maxEndpoints: 2, normalizePaths: false }, async ({ monitor, get }) => {
    for (let i = 0; i < 6; i++) await get(`/e${i}`);
    await settle();
    assert.strictEqual(monitor.getRequestLogs().length, 3);
    assert.strictEqual(monitor.getEndpointStats().length, 2);
    assert.strictEqual(monitor.getRequestStats().total, 6); // lifetime counters are kept
  });
  await withServer({ retentionTime: 30 }, async ({ monitor, get }) => {
    await get('/old'); await settle(80);
    monitor.cleanup();
    assert.strictEqual(monitor.getRequestLogs().length, 0);
    assert.strictEqual(monitor.getEndpointStats().length, 0);
    assert.strictEqual(monitor.getRequestStats().total, 1);
  });
  const rb = new RingBuffer(3);
  [1, 2, 3, 4, 5].forEach((n) => rb.push(n));
  assert.deepStrictEqual(rb.toArray(), [3, 4, 5]);
  rb.dropWhile((n) => n < 5);
  assert.deepStrictEqual(rb.toArray(), [5]);
});

test('reset clears collected data', async () => {
  await withServer({}, async ({ monitor, get }) => {
    await get('/boom'); await settle();
    monitor.reset();
    assert.strictEqual(monitor.getRequestStats().total, 0);
    assert.strictEqual(monitor.getErrors().length, 0);
    assert.strictEqual(monitor.getEndpointStats().length, 0);
  });
});

test('configuration validation', () => {
  assert.throws(() => new NodeApiWatch({ bogus: 1 }), /unknown option/);
  assert.throws(() => new NodeApiWatch({ slowRequestThreshold: -5 }), /slowRequestThreshold/);
  assert.throws(() => new NodeApiWatch({ maxStoredRequests: 0 }), /maxStoredRequests/);
  assert.throws(() => new NodeApiWatch({ rateLimit: { maxRequests: 0 } }), /maxRequests/);
  assert.throws(() => new NodeApiWatch({ rateLimit: { keyBy: 'nope' } }), /keyBy/);
  assert.throws(() => new NodeApiWatch({ rateLimit: { unknownKey: 1 } }), /unknown rateLimit/);
  assert.throws(() => new NodeApiWatch({ logging: 'bogus' }), /logging.mode/);
  assert.throws(() => new NodeApiWatch({ cpuThreshold: 150 }), /cpuThreshold/);
  assert.throws(() => new NodeApiWatch({ redactHeaders: 'authorization' }), /redactHeaders/);
  assert.throws(() => new NodeApiWatch({ classify: 'x' }), /classify/);
  assert.throws(() => new NodeApiWatch('x'), /plain object/);
  assert.throws(() => new NodeApiWatch().track({}, {}), /requires Node.js http/);
  assert.doesNotThrow(() => new NodeApiWatch({ rateLimit: true, logging: true, duplicateDetection: false }));
});

test('privacy: secrets never appear in records, errors, reports or logs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-priv-'));
  const file = path.join(dir, 'app.log');
  await withServer({ logging: { mode: 'file', format: 'json', file }, captureHeaders: true, redactHeaders: ['x-custom-secret'] },
    async ({ monitor, get }) => {
      await get('/login?password=hunter2&page=2&access_token=tok999&apikey=k1&q=hello', {
        method: 'POST',
        headers: { Authorization: 'Bearer secret-bearer-123', Cookie: 'sid=cookie-secret', 'X-API-Key': 'api-key-secret',
          'X-Custom-Secret': 'custom-secret', Accept: 'text/plain' },
        body: 'password=bodysecret',
      });
      await settle();
      const rec = monitor.getRequestLogs()[0];
      assert.strictEqual(rec.query.password, '[REDACTED]');
      assert.strictEqual(rec.query.access_token, '[REDACTED]');
      assert.strictEqual(rec.query.apikey, '[REDACTED]');
      assert.strictEqual(rec.query.page, '2');
      assert.strictEqual(rec.query.q, 'hello');
      assert.strictEqual(rec.headers.authorization, '[REDACTED]');
      assert.strictEqual(rec.headers.cookie, '[REDACTED]');
      assert.strictEqual(rec.headers['x-api-key'], '[REDACTED]');
      assert.strictEqual(rec.headers['x-custom-secret'], '[REDACTED]');
      assert.strictEqual(rec.headers.accept, 'text/plain');
      await monitor.stop(); // flush log
      const everything = JSON.stringify(monitor.getReport()) + JSON.stringify(monitor.getErrors()) + fs.readFileSync(file, 'utf8');
      for (const secret of ['hunter2', 'tok999', 'secret-bearer-123', 'cookie-secret', 'api-key-secret', 'custom-secret', 'bodysecret']) {
        assert.ok(!everything.includes(secret), `leaked: ${secret}`);
      }
    });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('headers are not stored unless captureHeaders is enabled', async () => {
  await withServer({}, async ({ monitor, get }) => {
    await get('/', { headers: { Authorization: 'Bearer abc' } }); await settle();
    assert.strictEqual(monitor.getRequestLogs()[0].headers, undefined);
  });
});

test('scrub removes bearer tokens and key=value secrets', () => {
  assert.ok(!scrub('Authorization: Bearer abc.def.ghi').includes('abc.def'));
  assert.ok(!scrub('connect failed password=hunter2 host=x').includes('hunter2'));
  assert.strictEqual(scrub('a\nb'), 'a b');
});

test('file logging: JSON lines and size-based rotation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-log-'));
  const file = path.join(dir, 'api.log');
  await withServer({ logging: { mode: 'file', format: 'json', file }, maxLogSize: 1024 }, async ({ monitor, get }) => {
    for (let i = 0; i < 12; i++) await get(`/api/item${i}`);
    await settle(60);
    await monitor.stop();
    assert.ok(fs.existsSync(`${file}.1`), 'rotated file should exist');
    const lines = fs.readFileSync(`${file}.1`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    for (const k of ['timestamp', 'requestId', 'method', 'path', 'statusCode', 'duration']) assert.ok(k in lines[0], k);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('text log format is a single line with requestId', () => {
  const m = new NodeApiWatch({ logging: { mode: 'console', format: 'text' } });
  const line = m._logger.format({ timestamp: 't', method: 'GET', path: '/a\nb', statusCode: 200, duration: 4, result: 'SUCCESS', requestId: 'id1' });
  assert.ok(!line.includes('\n'));
  assert.ok(line.includes('requestId=id1'));
});

test('async context exposes the current request id (opt-in)', async () => {
  let inside;
  const monitor = new NodeApiWatch({ asyncContext: true });
  const handler = async (req, res) => { await settle(5); inside = monitor.getCurrentRequestId(); res.end('ok'); };
  const server = http.createServer(monitor.wrap(handler));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await request(server.address().port);
  assert.strictEqual(inside, res.headers['x-request-id']);
  assert.strictEqual(monitor.getCurrentRequestId(), undefined); // outside the request
  server.closeAllConnections(); server.close();
});

test('middleware() works Express-style and wrap() blocks limited requests', async () => {
  const monitor = new NodeApiWatch({ rateLimit: { maxRequests: 1 } });
  const mw = monitor.middleware();
  const server = http.createServer((req, res) => mw(req, res, () => res.end('next-called')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  assert.strictEqual((await request(port)).body, 'next-called');
  assert.strictEqual((await request(port)).status, 429);
  server.closeAllConnections(); server.close();
});

test('diagnostics_channel auto-instrumentation tracks untouched servers (opt-in)', async () => {
  const monitor = new NodeApiWatch({ autoInstrument: true }).start();
  const server = http.createServer((req, res) => res.end('plain'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await request(server.address().port, '/auto');
  await settle();
  assert.strictEqual(monitor.getRequestStats().total, 1);
  await monitor.stop();
  await request(server.address().port, '/after-stop');
  await settle();
  assert.strictEqual(monitor.getRequestStats().total, 1);
  server.closeAllConnections(); server.close();
});

test('listener exceptions never break request handling', async () => {
  await withServer({}, async ({ monitor, get }) => {
    monitor.on('requestComplete', () => { throw new Error('listener bug'); });
    process.once('warning', () => {});
    const r = await get('/');
    assert.strictEqual(r.status, 200);
    await settle();
    assert.strictEqual(monitor.getRequestStats().total, 1);
  });
});

test('disabled monitor is a no-op', async () => {
  await withServer({ enabled: false }, async ({ monitor, get }) => {
    const r = await get('/');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['x-request-id'], undefined);
    assert.strictEqual(monitor.getRequestStats().total, 0);
  });
});

test('module exports: class and default-instance styles', async () => {
  assert.strictEqual(typeof NodeApiWatch, 'function');
  assert.ok(new NodeApiWatch() instanceof NodeApiWatch);
  assert.strictEqual(NodeApiWatch.NodeApiWatch, NodeApiWatch);
  const inst = NodeApiWatch.start();
  assert.ok(inst instanceof NodeApiWatch);
  assert.strictEqual(typeof NodeApiWatch.health().status, 'string');
  assert.strictEqual(typeof NodeApiWatch.getSystemStats().cpu.count, 'number');
  await NodeApiWatch.stop();
});

test('system monitor emits systemWarning once when a threshold is crossed', async () => {
  const m = new NodeApiWatch({ memoryThreshold: 0.001, cpuThreshold: 100 });
  const warnings = [];
  m.on('systemWarning', (w) => warnings.push(w));
  m._system.sample(); m._system.sample();
  assert.ok(warnings.some((w) => w.type === 'memory'));
  assert.strictEqual(warnings.filter((w) => w.type === 'memory').length, 1);
});

test('CLI: --version, --help and system', () => {
  const { execFileSync } = require('node:child_process');
  const bin = path.join(__dirname, '..', 'index.js');
  assert.strictEqual(execFileSync(process.execPath, [bin, '--version']).toString().trim(), NodeApiWatch.VERSION);
  assert.ok(execFileSync(process.execPath, [bin, '--help']).toString().includes('Usage'));
  const sys = JSON.parse(execFileSync(process.execPath, [bin, 'system']).toString());
  assert.ok(sys.cpu && sys.memory && sys.runtime);
});
