# node-api-watch

Lightweight, **dependency-free** API and system monitoring for Node.js backends.
Track requests, errors, response times, endpoint analytics, rate limits and system resources using
nothing but Node.js built-in modules.

> Status: v1.0.0. Single-file implementation, designed to be split into modules later without
> changing the public API.

## Features

- HTTP request monitoring (method, path, sanitized query, status, duration, sizes, IP, UA, HTTP version)
- Success / redirect / failure classification (customizable) with success, failure and error rates
- Request IDs via `crypto.randomUUID()` + `X-Request-ID` response header
- Performance stats: avg / min / max / p50 / p90 / p95 / p99, slow requests, requests per second
- Per-endpoint analytics with ID/UUID/token path normalization and a hard cap on entries
- Error tracking (4xx, 5xx, aborted connections, captured app errors, optional process-level errors)
- Request logging to console and/or file (text or JSON) with size-based rotation, async writes
- In-memory rate limiter (fixed window, per IP / IP+endpoint / custom key, pluggable store interface)
- Repeated-request detection (analytics only, never blocks)
- System monitoring: CPU % (computed from deltas), memory, V8 heap, event-loop delay, load average, runtime info
- Threshold-based `health()`, JSON reports, event emitter API
- Optional `AsyncLocalStorage` request context and `diagnostics_channel` auto-instrumentation
- Privacy-first defaults: no bodies, no headers, secrets redacted
- Small CLI: `node-api-watch system | report | --help | --version`

## Installation

```bash
npm install node-api-watch
```

Requires Node.js >= 18.17. No dependencies.

## Quick start

```js
const http = require('node:http');
const NodeApiWatch = require('node-api-watch');

const monitor = new NodeApiWatch({ logging: 'console', rateLimit: { maxRequests: 100 } });
monitor.start();

// wrap() tracks every request and (if enabled) answers 429 for you.
const server = http.createServer(monitor.wrap((req, res) => {
  res.writeHead(200);
  res.end('Hello');
}));
server.listen(3000);
```

Or call `track()` yourself. **It returns `false` when it already answered with `429`, and you must then
not touch `res`:**

```js
const server = http.createServer((req, res) => {
  if (!monitor.track(req, res)) return;
  res.writeHead(200);
  res.end('Hello');
});
```

A shared default instance is also available:

```js
const monitor = require('node-api-watch');
monitor.start();                          // uses default options
// monitor.configure({ ... }) replaces the default instance with custom options
```

## Configuration

All options are optional. Unknown options throw, so typos are caught early.

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | `false` turns `track()` into a no-op |
| `requestLogs` | `true` | keep full request records in memory (`getRequestLogs()`) |
| `performance` | `true` | timing aggregates + slow-request detection |
| `systemMonitor` | `true` | background CPU / event-loop sampling while started |
| `rateLimit` | `false` | `true`, or an object (below) |
| `duplicateDetection` | `true` | `false`, or `{ windowMs: 10000, threshold: 20, maxKeys, maxFlagged }` |
| `logging` | `false` | `true` (console), `'console' \| 'file' \| 'both' \| 'none'`, or `{ mode, format: 'text'\|'json', file, maxFiles }` |
| `requestIdHeader` | `'X-Request-ID'` | header name, or `false` to disable |
| `trustIncomingRequestId` | `false` | reuse a valid incoming `X-Request-ID` |
| `slowRequestThreshold` | `1000` | ms; requests above this are "slow" |
| `maxStoredRequests` / `maxStoredErrors` / `maxEndpoints` | `1000` / `200` / `500` | memory bounds |
| `maxLogSize` | `5 MB` | bytes per log file before rotation |
| `retentionTime` | `1 h` | in-memory records older than this are dropped |
| `cleanupInterval` | `60 s` | how often cleanup runs while started |
| `cpuSampleInterval` | `1000` | ms between CPU samples |
| `cpuThreshold` / `memoryThreshold` / `errorRateThreshold` | `90` / `90` / `10` | percent, used by `health()` and `systemWarning` |
| `healthWindow` / `healthMinRequests` | `60000` / `20` | window and minimum sample for the error-rate check |
| `redactHeaders` / `redactQueryParams` | `[]` | **added to** the built-in redaction lists |
| `captureQuery` / `captureHeaders` | `true` / `false` | store sanitized query / redacted headers |
| `normalizePaths` | `true` | `/users/42` becomes `/users/:id` for analytics |
| `trustProxy` | `false` | use `X-Forwarded-For` (only enable behind a proxy you control) |
| `recordIp` | `true` | store client IPs in records and logs |
| `classify` | `null` | `(status, {method, path}) => 'success'\|'redirect'\|'clientError'\|'serverError'\|'other'` (anything else falls back to default) |
| `asyncContext` | `false` | `AsyncLocalStorage` request context |
| `autoInstrument` | `false` | track every `node:http` server via `diagnostics_channel` |
| `captureProcessErrors` | `false` | record uncaught exceptions / unhandled rejections |

`rateLimit` object: `{ enabled, windowMs: 60000, maxRequests: 100, keyBy: 'ip' | 'ip+endpoint' | fn, enforce: true, headers: true, maxKeys: 10000, store }`.
Passing an object enables it.

## API reference

| Method | Returns |
|---|---|
| `start()` / `await stop()` | start/stop background work; `stop()` also flushes the log file |
| `track(req, res)` | `true`, or `false` if a 429 was sent |
| `wrap(handler)` / `middleware()` | plain-`http` handler wrapper / Connect-Express middleware |
| `captureError(req, err)` | attach an app error to the request (message is scrubbed) |
| `getRequestId(req)` / `getCurrentRequestId()` | request ID (the latter needs `asyncContext`) |
| `getRequestStats()` | `{ total, successful, redirects, clientErrors, serverErrors, aborted, successRate, failureRate, errorRate }` |
| `getPerformanceStats()` | `{ average, minimum, maximum, p50..p99, slowRequests, requestsPerSecond, ... }` |
| `getEndpointStats({limit, sortBy})` | per endpoint requests/success/errors/average/min/max |
| `getErrors(limit)` | newest first: timestamp, requestId, endpoint, method, status, message, type, duration |
| `getRequestLogs(limit)` | newest first full request records |
| `getRateLimitStats()` / `getRepeatedRequests()` | limiter counters / flagged repeated requests |
| `getSystemStats()` / `getCpuUsage()` | `{ cpu, memory, process, runtime }` / `{ systemPercent, processPercent, ... }` |
| `health()` | status plus the individual checks |
| `getReport()` / `exportReport()` / `await saveReport(file)` | report object / JSON string / writes JSON file |
| `cleanup()` / `reset()` | apply retention now / clear all collected data |

**Rate definitions** (percent of all tracked requests): `successRate` = 2xx; `failureRate` = 4xx + 5xx + aborted;
`errorRate` = 5xx only. Redirects (3xx) count as neither success nor failure.

## Request monitoring example

```js
monitor.on('requestComplete', (r) => {
  console.log(`${r.method} ${r.path} -> ${r.statusCode} in ${r.duration}ms [${r.result}]`);
});
// GET /api/users -> 200 in 32ms [SUCCESS]
// POST /api/login -> 401 in 41ms [FAILED]
```

## System monitoring example

```js
monitor.start();
setTimeout(() => {
  console.log(monitor.getCpuUsage());   // { systemPercent: 12.4, processPercent: 3.1, ... }
  console.log(monitor.getSystemStats().memory.heapUsedPercent);
}, 2000);
```

CPU % is computed from `os.cpus()` time deltas between samples (not raw counters).
`processPercent` is relative to one core and can exceed 100 with worker threads.

## Rate limiting example

```js
const monitor = new NodeApiWatch({
  rateLimit: { windowMs: 60_000, maxRequests: 100, keyBy: 'ip+endpoint' },
});
monitor.on('rateLimitExceeded', (e) => console.warn('limited', e.key, e.path));
```

Clients receive `429 Too Many Requests` with `Retry-After` and `X-RateLimit-*` headers.
Set `enforce: false` to only measure.

**Important:** the limiter is in-memory and **per process**. With several Node.js instances (cluster, PM2,
containers) every instance has its own counters, so the effective limit is multiplied. It uses a fixed
window, so a client can burst up to 2x at a window boundary. If the key table is full, the oldest keys are
evicted. A custom `store` object (`hit`, `cleanup`, `reset`, `size`) is supported, but in v1 it must be
**synchronous**; async/Redis adapters need a future major/minor version. If the limiter throws, requests
are allowed (fail-open).

## Reports

```js
const report = monitor.getReport();     // generatedAt, requests, performance, endpoints, errors, rateLimit, system, runtime
const json = monitor.exportReport();    // JSON string
await monitor.saveReport('./reports/latest.json');   // file mode 0600
```

Reports are snapshots; counters cover everything since start/`reset()`, while percentiles, requests per second and
the health error-rate use the bounded recent window.

## Health

`health()` returns `healthy`, `degraded` (1 failed check) or `unhealthy` (2+ failed). The checks are exactly:

1. system CPU % >= `cpuThreshold`
2. memory >= `memoryThreshold`, where memory is the larger of *system used %* and *V8 heap used / heap limit*
3. share of 5xx responses in the last `healthWindow` >= `errorRateThreshold` (only judged with at least `healthMinRequests` requests)

Checks without data are `unknown` and ignored. "Healthy" therefore means *no configured threshold was crossed*,
not that the application is correct. The defaults are conventional starting points, not universal truths; tune them.
On Linux, "system used" includes file cache, so it can read high on a healthy machine.

## Events

| Event | Payload |
|---|---|
| `request` | `{ requestId, method, path, ip, timestamp }` when tracking starts |
| `requestComplete` | the full request record |
| `requestError` | request record + `error: { type, message }` (4xx, 5xx, aborted, captured errors, process errors) |
| `slowRequest` | request record + `threshold` |
| `rateLimitExceeded` | `{ requestId, key, method, path, limit, windowMs, retryAfter, enforced }` |
| `systemWarning` | `{ type: 'cpu'\|'memory'\|'heap', value, threshold, message, timestamp }`, once per threshold crossing |
| `error` | internal monitor error (listener exceptions never break your app) |
| `reportGenerated` | the report object |

## Privacy and security

By default node-api-watch **never** reads request bodies and **never** stores headers. It records only the fields listed
above. Details:

- Query values for keys such as `password`, `token`, `secret`, `auth`, `session`, `jwt`, `api_key`, `code`, `sig` are replaced with
  `[REDACTED]`; add your own with `redactQueryParams`. Values are capped at 100 chars, 20 params.
- Headers are stored only with `captureHeaders: true`, and `authorization`, `cookie`, `set-cookie`, `x-api-key` and similar
  are always `[REDACTED]`. `redactHeaders` adds to the list; it cannot remove built-ins.
- Error messages are scrubbed of bearer tokens and `password=`/`token=`-style pairs (best effort, not a guarantee).
- Paths are stored as received (capped at 256 chars). Do not put secrets in URL paths.
- **IP addresses are personal data** in many jurisdictions (e.g. GDPR). Set `recordIp: false` to keep them out of records and logs
  (the rate limiter still needs them in memory).
- Request IDs from clients are ignored unless `trustIncomingRequestId` is on, and then validated, to prevent log injection.
- Log files are created with mode `0600`. Report files too.
- If you expose `getReport()` or `health()` over HTTP, protect that endpoint.

## Performance considerations

- Per-request work: one URL parse, a few Map/ring-buffer operations and one record object. No filesystem access on the request path
  (log writes use a stream; rotation is async).
- All memory is bounded: ring buffers (`maxStoredRequests`, `maxStoredErrors`), LRU-style endpoint map (`maxEndpoints`), capped limiter and
  duplicate-detector tables, plus time-based cleanup (`retentionTime`).
- Cheapest configuration: `requestLogs: false, duplicateDetection: false, performance: false`.
- A rough local micro-benchmark (empty handler, same-process client) showed tens of microseconds per request. Real handlers dwarf that,
  but measure in your own environment.
- `asyncContext` adds `AsyncLocalStorage` overhead and is off by default.

## Limitations

- In-memory only: data is lost on restart and not shared between processes; there is no persistence.
- Rate limiter is per process, fixed window, sync store only (see above).
- Response size is `Content-Length` when set, otherwise an approximation from socket bytes (includes headers).
- `autoInstrument` observes requests but **cannot block** them, so rate limits become observe-only in that mode.
- HTTP/2 compatibility API: basic tracking should work but is untested in v1.
- `captureProcessErrors` re-throws unhandled rejections when it is the only listener to mimic Node's default; this does not
  apply if you run Node with a non-default `--unhandled-rejections` mode.
- Event-loop delay and CPU sampling run only after `start()`.
- Not provided in v1: Fastify/Express-specific adapters, Redis store, Prometheus exporter, TypeScript typings, ESM entry point.

## Framework integration

- **Plain `node:http` / `node:https`**: `monitor.wrap(handler)` or `track(req, res)`.
- **Express / Connect**: `app.use(monitor.middleware())` (no dependency on Express; put it first).
- **Fastify and others**: use `autoInstrument: true` (works for anything built on `node:http`), or call `track()` from the framework's
  `onRequest` hook using `request.raw` / `reply.raw`. Dedicated adapters are planned.

## Testing

```bash
npm test      # node:test, no dev dependencies
```

## Contributing

Issues and pull requests are welcome. Keep the package dependency-free and privacy-conscious, add tests for every behavior change, and keep
public API changes backwards compatible (semver).

## License

[MIT](./LICENSE). MIT is a standard, permissive open-source software license (it is unrelated to the university of the same name).
## Device Information

Get information about the machine running your Node.js application:

```js
const NodeApiWatch = require("node-api-pulse");

const monitor = new NodeApiWatch();

console.log(monitor.deviceinfo);


---

# 8. Pack and inspect

```powershell
npm pack --dry-run
