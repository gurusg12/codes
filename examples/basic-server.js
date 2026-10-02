'use strict';

// Run with:  node examples/basic-server.js
const http = require('node:http');
const NodeApiWatch = require('../index.js');

const monitor = new NodeApiWatch({
  logging: 'console',
  slowRequestThreshold: 300,
  rateLimit: { windowMs: 10_000, maxRequests: 20 },
});

monitor.on('slowRequest', (r) => console.log(`🐌 slow: ${r.endpoint} took ${r.duration}ms`));
monitor.on('rateLimitExceeded', (e) => console.log(`⛔ rate limit: ${e.key} on ${e.path}`));
monitor.on('systemWarning', (w) => console.log(`⚠️  ${w.message}`));
monitor.start();

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = http.createServer(monitor.wrap((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/users') return json(res, 200, [{ id: 1, name: 'Ada' }]);
  if (pathname === '/api/slow') return setTimeout(() => json(res, 200, { slow: true }), 500);
  if (pathname === '/api/error') {
    monitor.captureError(req, new Error('simulated database failure'));
    return json(res, 500, { error: 'Internal Server Error' });
  }
  // Monitoring endpoints. In real apps, protect these (auth / private network)!
  if (pathname === '/_watch/health') return json(res, 200, monitor.health());
  if (pathname === '/_watch/report') return json(res, 200, monitor.getReport());
  return json(res, 404, { error: 'Not Found' });
}));

server.listen(3000, '127.0.0.1', () => {
  console.log('Listening on http://127.0.0.1:3000');
  console.log('Try: /api/users  /api/slow  /api/error  /_watch/health  /_watch/report');
});

process.on('SIGINT', async () => {
  await monitor.saveReport('./logs/final-report.json');
  await monitor.stop();
  server.close(() => process.exit(0));
});
