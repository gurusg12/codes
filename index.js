#!/usr/bin/env node
'use strict';

/**
 * node-api-watch — lightweight API & system monitoring for Node.js.
 * Zero dependencies: uses only Node.js built-in modules.
 *
 * v1 keeps everything in this single file, organised in clearly marked
 * sections so it can later be split into src/ modules without changing the
 * public API (see "FUTURE SPLIT" comments).
 *
 * Section map
 *   0. Imports
 *   1. Configuration
 *   2. Utilities
 *   3. Request ID
 *   4. Request statistics (success / failure classification)
 *   5. Performance monitor
 *   6. Error monitor
 *   7. Rate limiter
 *   8. Duplicate / repeated request detector
 *   9. System monitor
 *  10. Logger
 *  11. Endpoint analytics
 *  12. Main class (request tracking, health, reports, events)
 *  13. Exports
 *  14. CLI
 */

// ============================================================================
// 0. IMPORTS (Node.js built-ins only)
// ============================================================================
const http = require('node:http'); // only for http.STATUS_CODES
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const v8 = require('node:v8');
const util = require('node:util');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { URL, URLSearchParams } = require('node:url');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');
const diagnosticsChannel = require('node:diagnostics_channel');
const { execFileSync } = require('node:child_process');

const VERSION = require('./package.json').version;

// ============================================================================
// 1. CONFIGURATION            (FUTURE SPLIT: src/core/config.js)
// ============================================================================
const MB = 1024 * 1024;

/** Headers/params that are ALWAYS redacted; user lists are added to these. */
const ALWAYS_REDACT_HEADERS = [
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token', 'x-csrf-token',
];

const DEFAULTS = Object.freeze({
  enabled: true,
  requestLogs: true,          // keep full request records in memory
  performance: true,          // aggregate timing stats + slow request detection
  systemMonitor: true,        // CPU sampling / event-loop delay while started
  rateLimit: false,           // false | true | object (see RATE_LIMIT_DEFAULTS)
  duplicateDetection: true,   // false | true | object (see DUPLICATE_DEFAULTS)
  logging: false,             // false | true | 'console'|'file'|'both'|'none' | object
  requestIdHeader: 'X-Request-ID', // string, or false/null to disable the header
  trustIncomingRequestId: false,
  slowRequestThreshold: 1000, // ms
  maxStoredRequests: 1000,
  maxStoredErrors: 200,
  maxEndpoints: 500,
  maxLogSize: 5 * MB,         // bytes per log file before rotation
  retentionTime: 60 * 60 * 1000, // ms; older in-memory records are dropped
  cleanupInterval: 60 * 1000,
  cpuSampleInterval: 1000,
  memoryThreshold: 90,        // % (system memory used OR V8 heap used / heap limit)
  cpuThreshold: 90,           // % system CPU
  errorRateThreshold: 10,     // % of recent requests that were 5xx
  healthWindow: 60 * 1000,    // ms window for the error-rate health check
  healthMinRequests: 20,      // minimum requests in window to judge error rate
  redactHeaders: [],
  redactQueryParams: [],
  captureQuery: true,
  captureHeaders: false,      // headers are NOT stored unless enabled (then redacted)
  normalizePaths: true,       // /users/123 -> /users/:id for endpoint analytics
  trustProxy: false,          // trust X-Forwarded-For (spoofable if you have no proxy!)
  recordIp: true,
  classify: null,             // (statusCode, {method, path}) => category | undefined
  asyncContext: false,        // AsyncLocalStorage request context (wrap()/middleware())
  autoInstrument: false,      // diagnostics_channel auto tracking of http servers
  captureProcessErrors: false,// record uncaught exceptions / unhandled rejections
});

const RATE_LIMIT_DEFAULTS = Object.freeze({
  enabled: false,
  windowMs: 60 * 1000,
  maxRequests: 100,
  keyBy: 'ip',     // 'ip' | 'ip+endpoint' | (req, info) => string|null
  enforce: true,   // true: respond 429 from track(); false: observe/report only
  headers: true,   // X-RateLimit-* headers
  maxKeys: 10000,
  store: null,     // custom SYNC store: { hit(key, windowMs, now), cleanup(now), reset(), size() }
});

const DUPLICATE_DEFAULTS = Object.freeze({
  enabled: true,
  windowMs: 10 * 1000,
  threshold: 20,   // same client + method + endpoint this many times within windowMs
  maxKeys: 5000,
  maxFlagged: 200,
});

const LOGGING_DEFAULTS = Object.freeze({
  mode: 'console', // 'console' | 'file' | 'both' | 'none'
  format: 'text',  // 'text' | 'json'
  file: path.join('logs', 'node-api-watch.log'),
  maxFiles: 2,     // rotated backups kept (file.1, file.2, ...)
});

const CATEGORIES = ['success', 'redirect', 'clientError', 'serverError', 'other', 'aborted'];

function configError(message) {
  throw new TypeError(`node-api-watch: ${message}`);
}

function checkNumber(name, value, { min = 0, max = Infinity, int = false, allowEqualMin = false } = {}) {
  const ok = typeof value === 'number' && Number.isFinite(value) &&
    (allowEqualMin ? value >= min : value > min) && value <= max && (!int || Number.isInteger(value));
  if (!ok) configError(`"${name}" must be ${int ? 'an integer' : 'a number'} ${allowEqualMin ? '>=' : '>'} ${min}${max !== Infinity ? ` and <= ${max}` : ''}`);
}

function checkBoolean(name, value) {
  if (typeof value !== 'boolean') configError(`"${name}" must be a boolean`);
}

function checkStringArray(name, value) {
  if (!Array.isArray(value) || value.some((s) => typeof s !== 'string' || !s)) {
    configError(`"${name}" must be an array of non-empty strings`);
  }
}

/** Merge a `false | true | object` option with its defaults. */
function normalizeSub(name, value, defaults) {
  let merged;
  if (typeof value === 'boolean') {
    merged = { ...defaults, enabled: value };
  } else if (isPlainObject(value)) {
    const unknown = Object.keys(value).filter((k) => !(k in defaults));
    if (unknown.length) configError(`unknown ${name} option(s): ${unknown.join(', ')}`);
    merged = { ...defaults, enabled: true, ...value };
  } else {
    configError(`"${name}" must be a boolean or an object`);
  }
  return merged;
}

function normalizeConfig(options) {
  if (options === undefined || options === null) options = {};
  if (!isPlainObject(options)) configError('options must be a plain object');

  const unknown = Object.keys(options).filter((k) => !(k in DEFAULTS));
  if (unknown.length) configError(`unknown option(s): ${unknown.join(', ')}`);

  const cfg = { ...DEFAULTS, ...options };

  for (const key of ['enabled', 'requestLogs', 'performance', 'systemMonitor', 'trustIncomingRequestId',
    'captureQuery', 'captureHeaders', 'normalizePaths', 'trustProxy', 'recordIp', 'asyncContext',
    'autoInstrument', 'captureProcessErrors']) {
    checkBoolean(key, cfg[key]);
  }

  checkNumber('slowRequestThreshold', cfg.slowRequestThreshold);
  checkNumber('maxStoredRequests', cfg.maxStoredRequests, { int: true, max: 1e6 });
  checkNumber('maxStoredErrors', cfg.maxStoredErrors, { int: true, max: 1e6 });
  checkNumber('maxEndpoints', cfg.maxEndpoints, { int: true, max: 1e6 });
  checkNumber('maxLogSize', cfg.maxLogSize, { min: 1023, int: true });
  checkNumber('retentionTime', cfg.retentionTime);
  checkNumber('cleanupInterval', cfg.cleanupInterval, { min: 99 });
  checkNumber('cpuSampleInterval', cfg.cpuSampleInterval, { min: 99 });
  checkNumber('memoryThreshold', cfg.memoryThreshold, { max: 100 });
  checkNumber('cpuThreshold', cfg.cpuThreshold, { max: 100 });
  checkNumber('errorRateThreshold', cfg.errorRateThreshold, { max: 100 });
  checkNumber('healthWindow', cfg.healthWindow);
  checkNumber('healthMinRequests', cfg.healthMinRequests, { int: true });
  checkStringArray('redactHeaders', cfg.redactHeaders);
  checkStringArray('redactQueryParams', cfg.redactQueryParams);

  if (cfg.requestIdHeader !== false && cfg.requestIdHeader !== null &&
    !(typeof cfg.requestIdHeader === 'string' && /^[A-Za-z0-9-]+$/.test(cfg.requestIdHeader))) {
    configError('"requestIdHeader" must be a valid header name, or false/null to disable');
  }
  if (cfg.classify !== null && typeof cfg.classify !== 'function') configError('"classify" must be a function or null');

  // Rate limit
  cfg.rateLimit = normalizeSub('rateLimit', cfg.rateLimit, RATE_LIMIT_DEFAULTS);
  const rl = cfg.rateLimit;
  checkBoolean('rateLimit.enforce', rl.enforce);
  checkBoolean('rateLimit.headers', rl.headers);
  checkNumber('rateLimit.windowMs', rl.windowMs, { int: true });
  checkNumber('rateLimit.maxRequests', rl.maxRequests, { int: true });
  checkNumber('rateLimit.maxKeys', rl.maxKeys, { int: true });
  if (!(rl.keyBy === 'ip' || rl.keyBy === 'ip+endpoint' || typeof rl.keyBy === 'function')) {
    configError('"rateLimit.keyBy" must be "ip", "ip+endpoint" or a function');
  }
  if (rl.store !== null && !(rl.store && typeof rl.store.hit === 'function')) {
    configError('"rateLimit.store" must implement hit(key, windowMs, now)');
  }

  // Duplicate detection
  cfg.duplicateDetection = normalizeSub('duplicateDetection', cfg.duplicateDetection, DUPLICATE_DEFAULTS);
  const dd = cfg.duplicateDetection;
  checkNumber('duplicateDetection.windowMs', dd.windowMs, { int: true });
  checkNumber('duplicateDetection.threshold', dd.threshold, { int: true, min: 1, allowEqualMin: true });
  checkNumber('duplicateDetection.maxKeys', dd.maxKeys, { int: true });
  checkNumber('duplicateDetection.maxFlagged', dd.maxFlagged, { int: true });

  // Logging
  let logging = cfg.logging;
  if (logging === true) logging = { mode: 'console' };
  else if (logging === false) logging = { mode: 'none' };
  else if (typeof logging === 'string') logging = { mode: logging };
  if (!isPlainObject(logging)) configError('"logging" must be a boolean, a mode string, or an object');
  const unknownLog = Object.keys(logging).filter((k) => !(k in LOGGING_DEFAULTS));
  if (unknownLog.length) configError(`unknown logging option(s): ${unknownLog.join(', ')}`);
  cfg.logging = { ...LOGGING_DEFAULTS, ...logging };
  if (!['console', 'file', 'both', 'none'].includes(cfg.logging.mode)) {
    configError('"logging.mode" must be one of: console, file, both, none');
  }
  if (!['text', 'json'].includes(cfg.logging.format)) configError('"logging.format" must be "text" or "json"');
  if (typeof cfg.logging.file !== 'string' || !cfg.logging.file) configError('"logging.file" must be a non-empty string');
  checkNumber('logging.maxFiles', cfg.logging.maxFiles, { int: true });
  cfg.logging.file = path.resolve(cfg.logging.file);

  // Derived, frozen lookups (user lists are ADDED to the built-in minimum)
  cfg._redactHeaderSet = new Set([...ALWAYS_REDACT_HEADERS, ...cfg.redactHeaders.map((h) => h.toLowerCase())]);
  cfg._isSensitiveParam = buildParamRedactor(cfg.redactQueryParams);
  return cfg;
}

// ============================================================================
// 2. UTILITIES                (FUTURE SPLIT: src/utils/)
// ============================================================================
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const truncate = (s, n) => { s = String(s); return s.length > n ? `${s.slice(0, n)}…` : s; };

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = clamp(Math.ceil((p / 100) * sortedAsc.length) - 1, 0, sortedAsc.length - 1);
  return sortedAsc[idx];
}

const SECRET_PATTERNS = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]'],
  [/\b(pass(?:word|wd)?|token|secret|api[_-]?key|authorization|cookie|session(?:id)?)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2[REDACTED]'],
];

/** Removes obvious secrets from free-text (e.g. error messages) and bounds length. */
function scrub(message, max = 300) {
  let s = String(message);
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return truncate(s.replace(/[\r\n\t]+/g, ' '), max);
}

const SENSITIVE_PARAM_RE = /pass|token|secret|auth|session|jwt|signature|credential|api[-_]?key|^(otp|key|code|sid|sig)$/i;

function buildParamRedactor(extra) {
  const set = new Set(extra.map((s) => s.toLowerCase()));
  return (name) => set.has(name.toLowerCase()) || SENSITIVE_PARAM_RE.test(name);
}

function parseUrl(raw) {
  try {
    const u = new URL(raw, 'http://localhost');
    return { pathname: u.pathname.slice(0, 256) || '/', searchParams: u.searchParams };
  } catch {
    const q = raw.indexOf('?');
    return { pathname: (q === -1 ? raw : raw.slice(0, q)).slice(0, 256) || '/', searchParams: new URLSearchParams() };
  }
}

/** Query params with sensitive values replaced. Max 20 params, values <= 100 chars. */
function sanitizeQuery(searchParams, isSensitive) {
  const out = Object.create(null);
  let n = 0;
  for (const [key, value] of searchParams) {
    if (n++ >= 20) break;
    if (key in out) continue;
    out[key] = isSensitive(key) ? '[REDACTED]' : truncate(value, 100);
  }
  return out;
}

function queryToString(query) {
  const parts = Object.keys(query).map((k) =>
    `${encodeURIComponent(k)}=${query[k] === '[REDACTED]' ? query[k] : encodeURIComponent(query[k])}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collapses ids/tokens so endpoint analytics keeps bounded cardinality. */
function normalizePath(pathname) {
  return pathname.split('/').map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return ':id';
    if (UUID_RE.test(seg)) return ':uuid';
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ':hex';
    if (seg.length >= 24 && /^[\w-]+$/.test(seg)) return ':token';
    return seg;
  }).join('/');
}

function redactHeaderMap(headers, redactSet) {
  const out = Object.create(null);
  for (const key of Object.keys(headers)) {
    const v = headers[key];
    out[key] = redactSet.has(key.toLowerCase()) ? '[REDACTED]' : truncate(Array.isArray(v) ? v.join(', ') : v, 200);
  }
  return out;
}

function getClientIp(req, trustProxy) {
  let ip = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string') {
      const first = xff.split(',')[0].trim();
      if (net.isIP(first)) ip = first;
    }
  }
  if (ip && ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return ip;
}

/** Fixed-capacity ring buffer: O(1) push, oldest entries overwritten. */
class RingBuffer {
  constructor(capacity) {
    this.cap = capacity;
    this.buf = new Array(capacity);
    this.start = 0;
    this.size = 0;
  }
  push(value) {
    if (this.size < this.cap) {
      this.buf[(this.start + this.size) % this.cap] = value;
      this.size++;
    } else {
      this.buf[this.start] = value;
      this.start = (this.start + 1) % this.cap;
    }
  }
  get(i) { return this.buf[(this.start + i) % this.cap]; }
  toArray() { const out = new Array(this.size); for (let i = 0; i < this.size; i++) out[i] = this.get(i); return out; }
  /** Drops entries from the oldest end while predicate(entry) is true. */
  dropWhile(pred) {
    while (this.size > 0 && pred(this.get(0))) {
      this.buf[this.start] = undefined;
      this.start = (this.start + 1) % this.cap;
      this.size--;
    }
  }
  clear() { this.buf = new Array(this.cap); this.start = 0; this.size = 0; }
}

// ============================================================================
// 3. REQUEST ID               (FUTURE SPLIT: src/core/request-id.js)
// ============================================================================
const INCOMING_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function createRequestId(req, trustIncoming) {
  if (trustIncoming) {
    const incoming = req.headers['x-request-id'];
    if (typeof incoming === 'string' && INCOMING_ID_RE.test(incoming)) return incoming;
  }
  return crypto.randomUUID();
}

// ============================================================================
// 4. REQUEST STATISTICS       (FUTURE SPLIT: src/monitoring/request-stats.js)
// ============================================================================
function defaultClassify(status) {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400 && status < 500) return 'clientError';
  if (status >= 500 && status < 600) return 'serverError';
  return 'other';
}

const RESULT_LABEL = {
  success: 'SUCCESS', redirect: 'REDIRECT', clientError: 'FAILED',
  serverError: 'FAILED', aborted: 'FAILED', other: 'OTHER',
};

class RequestStats {
  constructor() { this.reset(); }
  reset() {
    this.total = 0; this.successful = 0; this.redirects = 0;
    this.clientErrors = 0; this.serverErrors = 0; this.other = 0; this.aborted = 0;
    this.since = new Date().toISOString();
  }
  record(category) {
    this.total++;
    switch (category) {
      case 'success': this.successful++; break;
      case 'redirect': this.redirects++; break;
      case 'clientError': this.clientErrors++; break;
      case 'serverError': this.serverErrors++; break;
      case 'aborted': this.aborted++; break;
      default: this.other++;
    }
  }
  /** Rates are percentages (0-100). See README for exact definitions. */
  snapshot() {
    const t = this.total;
    const pct = (n) => (t ? round((n / t) * 100) : 0);
    const failed = this.clientErrors + this.serverErrors + this.aborted;
    return {
      total: t, successful: this.successful, redirects: this.redirects,
      clientErrors: this.clientErrors, serverErrors: this.serverErrors,
      aborted: this.aborted, other: this.other,
      successRate: pct(this.successful),
      failureRate: pct(failed),
      errorRate: pct(this.serverErrors),
      since: this.since,
    };
  }
}

// ============================================================================
// 5. PERFORMANCE MONITOR      (FUTURE SPLIT: src/performance/)
// ============================================================================
class PerformanceMonitor {
  constructor(cfg) { this.cfg = cfg; this.reset(); }
  reset() { this.count = 0; this.sum = 0; this.min = Infinity; this.max = 0; this.slow = 0; this.startedAt = Date.now(); }
  record(duration, isSlow) {
    this.count++; this.sum += duration;
    if (duration < this.min) this.min = duration;
    if (duration > this.max) this.max = duration;
    if (isSlow) this.slow++;
  }
  /** recent: RingBuffer of {ts, duration, category} (bounded window used for percentiles / rps). */
  getStats(recent, now = Date.now()) {
    if (!this.cfg.performance) return { enabled: false };
    const durations = [];
    for (let i = 0; i < recent.size; i++) durations.push(recent.get(i).duration);
    durations.sort((a, b) => a - b);

    const windowMs = 60 * 1000;
    let inWindow = 0;
    for (let i = recent.size - 1; i >= 0; i--) {
      if (recent.get(i).ts < now - windowMs) break;
      inWindow++;
    }
    const full = recent.size === recent.cap && inWindow === recent.size;
    const span = full ? now - recent.get(0).ts : Math.min(windowMs, now - this.startedAt);

    return {
      enabled: true,
      count: this.count,
      average: this.count ? round(this.sum / this.count) : 0,
      minimum: this.count ? round(this.min) : 0,
      maximum: round(this.max),
      p50: round(percentile(durations, 50)),
      p90: round(percentile(durations, 90)),
      p95: round(percentile(durations, 95)),
      p99: round(percentile(durations, 99)),
      percentileSampleSize: durations.length,
      slowRequests: this.slow,
      slowRequestThreshold: this.cfg.slowRequestThreshold,
      requestsPerSecond: span >= 1000 ? round(inWindow / (span / 1000)) : null,
      unit: 'ms',
    };
  }
}

// ============================================================================
// 6. ERROR MONITOR            (FUTURE SPLIT: src/monitoring/errors.js)
// ============================================================================
class ErrorMonitor {
  constructor(capacity) { this.ring = new RingBuffer(capacity); this.total = 0; }
  record(entry) { this.total++; this.ring.push({ ts: Date.now(), data: entry }); }
  /** Newest first. */
  list(limit) {
    const out = [];
    for (let i = this.ring.size - 1; i >= 0 && out.length < limit; i--) out.push(this.ring.get(i).data);
    return out;
  }
  cleanup(cutoff) { this.ring.dropWhile((e) => e.ts < cutoff); }
  reset() { this.ring.clear(); this.total = 0; }
}

// ============================================================================
// 7. RATE LIMITER             (FUTURE SPLIT: src/rate-limit/)
// ============================================================================
/**
 * Fixed-window in-memory store. SINGLE PROCESS ONLY.
 * Custom stores (e.g. Redis, in a future version) implement the same interface.
 */
class MemoryStore {
  constructor(maxKeys) { this.map = new Map(); this.maxKeys = maxKeys; }
  hit(key, windowMs, now) {
    let e = this.map.get(key);
    if (!e || e.resetAt <= now) {
      if (e) this.map.delete(key);
      else if (this.map.size >= this.maxKeys) this.map.delete(this.map.keys().next().value);
      e = { count: 0, resetAt: now + windowMs };
      this.map.set(key, e);
    }
    e.count++;
    return { count: e.count, resetAt: e.resetAt };
  }
  cleanup(now) { for (const [k, e] of this.map) if (e.resetAt <= now) this.map.delete(k); }
  reset() { this.map.clear(); }
  size() { return this.map.size; }
}

class RateLimiter {
  constructor(cfg) {
    this.cfg = cfg;
    this.store = cfg.store || new MemoryStore(cfg.maxKeys);
    this.resetStats();
  }
  resetStats() { this.checked = 0; this.allowed = 0; this.limited = 0; this.limitedKeys = new Map(); }
  check(key, now) {
    const r = this.store.hit(key, this.cfg.windowMs, now);
    if (r && typeof r.then === 'function') {
      throw new TypeError('async rate-limit stores are not supported in v1; hit() must be synchronous');
    }
    this.checked++;
    const limited = r.count > this.cfg.maxRequests;
    if (limited) {
      this.limited++;
      if (this.limitedKeys.size >= 100 && !this.limitedKeys.has(key)) this.limitedKeys.delete(this.limitedKeys.keys().next().value);
      this.limitedKeys.set(key, (this.limitedKeys.get(key) || 0) + 1);
    } else {
      this.allowed++;
    }
    return {
      limited, limit: this.cfg.maxRequests,
      remaining: Math.max(0, this.cfg.maxRequests - r.count),
      resetAt: r.resetAt, retryAfter: Math.max(1, Math.ceil((r.resetAt - now) / 1000)),
    };
  }
  cleanup(now) { if (this.store.cleanup) this.store.cleanup(now); }
  reset() { if (this.store.reset) this.store.reset(); this.resetStats(); }
  getStats() {
    const top = [...this.limitedKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([key, count]) => ({ key, blocked: count }));
    return {
      enabled: this.cfg.enabled, windowMs: this.cfg.windowMs, maxRequests: this.cfg.maxRequests,
      enforce: this.cfg.enforce, checked: this.checked, allowed: this.allowed, limited: this.limited,
      activeKeys: this.store.size ? this.store.size() : null, topLimited: top,
      scope: 'single-process (in-memory)',
    };
  }
}

// ============================================================================
// 8. DUPLICATE / REPEATED REQUEST DETECTOR   (FUTURE SPLIT: src/analytics/)
// ============================================================================
/** Analytics only — never blocks. Counts same client + method + endpoint inside a window. */
class DuplicateDetector {
  constructor(cfg) { this.cfg = cfg; this.reset(); }
  reset() { this.map = new Map(); this.flagged = new Map(); }
  record(ip, method, endpointPath, now) {
    const key = `${ip}|${method} ${endpointPath}`;
    let e = this.map.get(key);
    if (!e) {
      if (this.map.size >= this.cfg.maxKeys) this.map.delete(this.map.keys().next().value);
      e = { ts: [], ip, method, path: endpointPath };
      this.map.set(key, e);
    }
    e.ts.push(now);
    const cutoff = now - this.cfg.windowMs;
    let drop = 0;
    while (drop < e.ts.length && e.ts[drop] < cutoff) drop++;
    if (drop) e.ts.splice(0, drop);
    if (e.ts.length > 10000) e.ts.splice(0, e.ts.length - 10000);

    if (e.ts.length >= this.cfg.threshold) {
      const prev = this.flagged.get(key);
      if (!prev && this.flagged.size >= this.cfg.maxFlagged) this.flagged.delete(this.flagged.keys().next().value);
      this.flagged.set(key, {
        endpoint: `${method} ${endpointPath}`, method, path: endpointPath, ip,
        count: Math.max(prev ? prev.count : 0, e.ts.length), window: this.cfg.windowMs,
        firstFlaggedAt: prev ? prev.firstFlaggedAt : new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(), lastSeenMs: now,
      });
    }
  }
  cleanup(now, cutoff) {
    for (const [k, e] of this.map) if (!e.ts.length || e.ts[e.ts.length - 1] < now - this.cfg.windowMs) this.map.delete(k);
    for (const [k, f] of this.flagged) if (f.lastSeenMs < cutoff) this.flagged.delete(k);
  }
  list() {
    return [...this.flagged.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs)
      .map(({ lastSeenMs, ...rest }) => rest);
  }
}

// ============================================================================
// 9. SYSTEM MONITOR           (FUTURE SPLIT: src/system/)
// ============================================================================
function readCpuTimes() {
  let idle = 0; let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** CPU % between two readCpuTimes() snapshots; null when there is no elapsed time. */
function computeCpuUsage(prev, cur) {
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0) return null;
  return round(clamp((1 - dIdle / dTotal) * 100, 0, 100));
}

function getMemoryInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const m = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  return {
    total, free, used, usedPercent: round((used / total) * 100),
    rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, heapLimit,
    heapUsedPercent: round((m.heapUsed / heapLimit) * 100),
    external: m.external, arrayBuffers: m.arrayBuffers,
  };
}

class SystemMonitor {
  constructor(cfg, onWarning) {
    this.cfg = cfg; this.onWarning = onWarning;
    this.timer = null; this.loop = null;
    this._init();
  }
  _init() {
    this.prevTimes = readCpuTimes();
    this.prevProc = process.cpuUsage();
    this.prevProcT = performance.now();
    this.lastSampleMs = 0;
    this.last = { systemPercent: null, processPercent: null, sampledAt: null, sampleWindowMs: null };
    this.lastLoop = { mean: 0, p99: 0, max: 0 };
    this.warned = {};
  }
  start() {
    if (this.timer) return;
    this._init();
    this.loop = monitorEventLoopDelay({ resolution: 10 });
    this.loop.enable();
    this.timer = setInterval(() => { try { this.sample(); } catch (e) { /* never crash the app */ } }, this.cfg.cpuSampleInterval);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.loop) this.loop.disable();
    this.timer = null; this.loop = null;
  }
  sample() {
    const now = performance.now();
    const times = readCpuTimes();
    const sys = computeCpuUsage(this.prevTimes, times);
    const elapsed = now - this.prevProcT;
    const pu = process.cpuUsage(this.prevProc);
    const proc = elapsed > 0 ? round(((pu.user + pu.system) / 1000 / elapsed) * 100) : null;
    this.prevTimes = times; this.prevProc = process.cpuUsage(); this.prevProcT = now;
    this.lastSampleMs = Date.now();
    if (sys !== null) {
      this.last = { systemPercent: sys, processPercent: proc, sampledAt: new Date().toISOString(), sampleWindowMs: round(elapsed) };
    }
    if (this.loop) {
      const ms = (n) => (Number.isFinite(n) ? round(n / 1e6) : 0);
      this.lastLoop = { mean: ms(this.loop.mean), p99: ms(this.loop.percentile(99)), max: ms(this.loop.max) };
      this.loop.reset();
    }
    this._checkWarnings();
    return this.last;
  }
  _checkWarnings() {
    const mem = getMemoryInfo();
    const checks = [
      ['cpu', this.last.systemPercent, this.cfg.cpuThreshold],
      ['memory', mem.usedPercent, this.cfg.memoryThreshold],
      ['heap', mem.heapUsedPercent, this.cfg.memoryThreshold],
    ];
    for (const [type, value, threshold] of checks) {
      if (value === null) continue;
      const over = value >= threshold;
      if (over && !this.warned[type]) {
        this.warned[type] = true;
        this.onWarning({
          type, value, threshold, timestamp: new Date().toISOString(),
          message: `${type} usage ${value}% reached threshold ${threshold}%`
        });
      } else if (!over) {
        this.warned[type] = false;
      }
    }
  }
  /** Returns the latest CPU sample; samples on demand when the background timer is not running. */
  getCpuUsage() {
    if (!this.timer && Date.now() - this.lastSampleMs > 1000) this.sample();
    return { ...this.last };
  }
  getStats() {
    const cpus = os.cpus();
    const usage = this.getCpuUsage();
    const loadSupported = process.platform !== 'win32';
    return {
      cpu: {
        count: typeof os.availableParallelism === 'function' ? os.availableParallelism() : cpus.length,
        model: cpus[0] ? cpus[0].model : null,
        usage,
        loadAverage: loadSupported ? os.loadavg().map((n) => round(n)) : null,
      },
      memory: getMemoryInfo(),
      process: {
        pid: process.pid, uptime: round(process.uptime()),
        eventLoopDelay: { ...this.lastLoop, unit: 'ms', sampled: this.timer !== null },
      },
      runtime: {
        nodeVersion: process.version, v8Version: process.versions.v8,
        platform: process.platform, arch: process.arch, systemUptime: round(os.uptime()),
      },
    };
  }
}


function getDeviceStorage() {
  try {
    // Windows
    if (process.platform === 'win32') {
      const drive = path.parse(process.cwd()).root.replace(/\\$/, '');

      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress)`
        ],
        {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true
        }
      ).trim();

      const data = JSON.parse(output);

      const total = Number(data.Size || 0);
      const free = Number(data.FreeSpace || 0);
      const used = Math.max(0, total - free);

      return {
        drive,
        totalBytes: total,
        usedBytes: used,
        freeBytes: free,
        totalGB: round(total / (1024 ** 3)),
        usedGB: round(used / (1024 ** 3)),
        freeGB: round(free / (1024 ** 3)),
        usedPercent: total
          ? round((used / total) * 100)
          : null
      };
    }

    // Linux / macOS
    const output = execFileSync(
      'df',
      ['-kP', process.cwd()],
      {
        encoding: 'utf8',
        timeout: 3000
      }
    ).trim();

    const lines = output.split('\n');

    if (lines.length < 2) return null;

    const parts = lines[lines.length - 1].trim().split(/\s+/);

    const totalKB = Number(parts[1]);
    const usedKB = Number(parts[2]);
    const freeKB = Number(parts[3]);

    const total = totalKB * 1024;
    const used = usedKB * 1024;
    const free = freeKB * 1024;

    return {
      drive: parts[5] || process.cwd(),
      totalBytes: total,
      usedBytes: used,
      freeBytes: free,
      totalGB: round(total / (1024 ** 3)),
      usedGB: round(used / (1024 ** 3)),
      freeGB: round(free / (1024 ** 3)),
      usedPercent: total
        ? round((used / total) * 100)
        : null
    };
  } catch {
    return null;
  }
}


// ============================================================================
// 10. LOGGER                  (FUTURE SPLIT: src/logging/)
// ============================================================================
/** Console and/or file logger. File writes are async (stream), with size-based rotation. */
class Logger {
  constructor(cfg, maxLogSize, onError) {
    this.cfg = cfg; this.maxSize = maxLogSize; this.onError = onError;
    this.toConsole = cfg.mode === 'console' || cfg.mode === 'both';
    this.toFile = cfg.mode === 'file' || cfg.mode === 'both';
    this.stream = null; this.size = 0; this.rotating = false; this.rotationPromise = null;
    this.pending = []; this.dropped = 0; this.broken = false;
  }
  get active() { return this.toConsole || this.toFile; }
  format(rec) {
    if (this.cfg.format === 'json') {
      const o = {
        timestamp: rec.timestamp, requestId: rec.requestId, method: rec.method, path: rec.path,
        statusCode: rec.statusCode, duration: rec.duration, result: rec.result
      };
      if (rec.slow) o.slow = true;
      if (rec.ip) o.ip = rec.ip;
      return JSON.stringify(o);
    }
    // eslint-disable-next-line no-control-regex
    const safePath = rec.path.replace(/[\u0000-\u001f\u007f]/g, '?');
    return `${rec.timestamp} ${rec.method} ${safePath} ${rec.statusCode} ${rec.duration}ms ${rec.result} requestId=${rec.requestId}`;
  }
  log(rec) {
    if (!this.active) return;
    const line = this.format(rec);
    if (this.toConsole) console.log(line);
    if (this.toFile && !this.broken) this._write(`${line}\n`);
  }
  open() { if (this.toFile && !this.stream && !this.rotating && !this.broken) this._open(); }
  _open() {
    try {
      fs.mkdirSync(path.dirname(this.cfg.file), { recursive: true });
      try { this.size = fs.statSync(this.cfg.file).size; } catch { this.size = 0; }
      this.stream = fs.createWriteStream(this.cfg.file, { flags: 'a', mode: 0o600 });
      this.stream.on('error', (err) => { this.stream = null; this.broken = true; this.onError(err); });
      for (const p of this.pending.splice(0)) { this.stream.write(p); this.size += Buffer.byteLength(p); }
    } catch (err) {
      this.broken = true;
      this.onError(err);
    }
  }
  _write(buf) {
    if (this.rotating || !this.stream) {
      if (this.pending.length < 1000) this.pending.push(buf); else this.dropped++;
      if (!this.stream && !this.rotating) this._open();
      return;
    }
    this.stream.write(buf);
    this.size += Buffer.byteLength(buf);
    if (this.size >= this.maxSize) this._rotate();
  }
  _rotate() {
    this.rotating = true;
    const s = this.stream; this.stream = null;
    this.rotationPromise = new Promise((resolve) => s.end(resolve))
      .then(() => this._shiftFiles())
      .catch((err) => this.onError(err))
      .then(() => { this.rotating = false; this.rotationPromise = null; this._open(); });
  }
  async _shiftFiles() {
    const base = this.cfg.file; const keep = this.cfg.maxFiles;
    await fs.promises.unlink(`${base}.${keep}`).catch(() => { });
    for (let i = keep - 1; i >= 1; i--) await fs.promises.rename(`${base}.${i}`, `${base}.${i + 1}`).catch(() => { });
    await fs.promises.rename(base, `${base}.1`).catch(() => { });
  }
  async close() {
    if (this.rotationPromise) await this.rotationPromise;
    if (this.stream) {
      const s = this.stream; this.stream = null;
      await new Promise((resolve) => s.end(resolve));
    }
    this.pending.length = 0;
  }
}

// ============================================================================
// 11. ENDPOINT ANALYTICS      (FUTURE SPLIT: src/analytics/endpoints.js)
// ============================================================================
class EndpointAnalytics {
  constructor(max) { this.max = max; this.map = new Map(); }
  record(method, endpointPath, category, duration, now) {
    const key = `${method} ${endpointPath}`;
    let e = this.map.get(key);
    if (e) this.map.delete(key); // re-insert => Map order == recency (LRU eviction)
    else e = {
      endpoint: key, method, path: endpointPath, requests: 0, success: 0, redirects: 0,
      clientErrors: 0, serverErrors: 0, aborted: 0, sum: 0, min: Infinity, max: 0, lastSeenMs: 0
    };
    e.requests++; e.sum += duration; e.lastSeenMs = now;
    if (duration < e.min) e.min = duration;
    if (duration > e.max) e.max = duration;
    if (category === 'success') e.success++;
    else if (category === 'redirect') e.redirects++;
    else if (category === 'clientError') e.clientErrors++;
    else if (category === 'serverError') e.serverErrors++;
    else if (category === 'aborted') e.aborted++;
    this.map.set(key, e);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  list({ limit = 100, sortBy = 'requests' } = {}) {
    const rows = [...this.map.values()].map((e) => ({
      endpoint: e.endpoint, method: e.method, path: e.path, requests: e.requests, success: e.success,
      redirects: e.redirects, errors: e.clientErrors + e.serverErrors + e.aborted,
      clientErrors: e.clientErrors, serverErrors: e.serverErrors, aborted: e.aborted,
      averageDuration: round(e.sum / e.requests), minimum: round(e.min), maximum: round(e.max),
      lastSeen: new Date(e.lastSeenMs).toISOString(),
    }));
    if (!['requests', 'errors', 'averageDuration', 'maximum'].includes(sortBy)) sortBy = 'requests';
    rows.sort((a, b) => b[sortBy] - a[sortBy]);
    return rows.slice(0, limit);
  }
  cleanup(cutoff) { for (const [k, e] of this.map) if (e.lastSeenMs < cutoff) this.map.delete(k); }
  reset() { this.map.clear(); }
}

// ============================================================================
// 12. MAIN CLASS              (FUTURE SPLIT: src/core/node-api-watch.js)
// ============================================================================
class NodeApiWatch extends EventEmitter {
  /** @param {object} [options] see README "Configuration" */
  constructor(options = {}) {
    super();
    this.config = normalizeConfig(options);
    const cfg = this.config;

    this._startedAt = Date.now();
    this._running = false;
    this._contexts = new WeakMap();   // req -> tracking context
    this._reqErrors = new WeakMap();  // req -> Error captured by the app
    this._als = cfg.asyncContext ? new AsyncLocalStorage() : null;

    this._stats = new RequestStats();
    this._perf = new PerformanceMonitor(cfg);
    this._errors = new ErrorMonitor(cfg.maxStoredErrors);
    this._endpoints = new EndpointAnalytics(cfg.maxEndpoints);
    this._recent = new RingBuffer(cfg.maxStoredRequests);  // light entries: percentiles, rps, health
    this._logs = new RingBuffer(cfg.maxStoredRequests);    // full records (requestLogs: true)
    this._limiter = cfg.rateLimit.enabled ? new RateLimiter(cfg.rateLimit) : null;
    this._dups = cfg.duplicateDetection.enabled ? new DuplicateDetector(cfg.duplicateDetection) : null;
    this._system = new SystemMonitor(cfg, (w) => this._safeEmit('systemWarning', w));
    this._logger = new Logger(cfg.logging, cfg.maxLogSize, (e) => this._internalError(e));
    this._channel = diagnosticsChannel.channel('node-api-watch:request');
    this._cleanupTimer = null;
  }

  // ---- lifecycle ---------------------------------------------------------
  /** Starts background work (CPU sampling, cleanup, log file, optional hooks). track() works without it. */


  getDeviceInfo() {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    const cpus = os.cpus();

    const platformNames = {
      win32: 'Windows',
      darwin: 'macOS',
      linux: 'Linux',
      freebsd: 'FreeBSD',
      openbsd: 'OpenBSD',
      android: 'Android',
      aix: 'AIX'
    };

    const now = new Date();

    const timestamp = now.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    return {
      hostname: os.hostname(),

      platform: process.platform,

      os: platformNames[process.platform] || process.platform,

      osRelease: os.release(),

      architecture: process.arch,

      cpu: {
        model: cpus[0] ? cpus[0].model : null,
        cores: typeof os.availableParallelism === 'function'
          ? os.availableParallelism()
          : cpus.length
      },

      memory: {
        totalBytes: totalMemory,
        usedBytes: usedMemory,
        freeBytes: freeMemory,
        totalGB: round(totalMemory / (1024 ** 3)),
        usedGB: round(usedMemory / (1024 ** 3)),
        freeGB: round(freeMemory / (1024 ** 3)),
        usedPercent: round((usedMemory / totalMemory) * 100)
      },

      storage: getDeviceStorage(),

      node: {
        version: process.version,
        processId: process.pid,
        uptimeSeconds: round(process.uptime())
      },

      timestamp,

      timezone: 'Asia/Kolkata',

      timezoneLabel: 'IST'
    };
  }

  start() {
    if (this._running || !this.config.enabled) return this;
    this._running = true;
    if (this.config.systemMonitor) this._system.start();
    this._logger.open();
    this._cleanupTimer = setInterval(() => this.cleanup(), this.config.cleanupInterval);
    this._cleanupTimer.unref();

    if (this.config.autoInstrument && typeof diagnosticsChannel.subscribe === 'function') {
      this._onHttpStart = (msg) => {
        try { if (msg && msg.request && msg.response) this.track(msg.request, msg.response, { observeOnly: true }); }
        catch (e) { this._internalError(e); }
      };
      diagnosticsChannel.subscribe('http.server.request.start', this._onHttpStart);
    }
    if (this.config.captureProcessErrors) this._installProcessHooks();
    return this;
  }

  /** Stops timers/hooks and flushes the log file. Returns a Promise. */
  async stop() {
    this._running = false;
    this._system.stop();
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = null;
    if (this._onHttpStart) { diagnosticsChannel.unsubscribe('http.server.request.start', this._onHttpStart); this._onHttpStart = null; }
    this._removeProcessHooks();
    await this._logger.close();
    return this;
  }

  /** Clears all collected data (configuration is kept). */
  reset() {
    this._startedAt = Date.now();
    this._stats.reset(); this._perf.reset(); this._errors.reset(); this._endpoints.reset();
    this._recent.clear(); this._logs.clear();
    if (this._limiter) this._limiter.reset();
    if (this._dups) this._dups.reset();
    return this;
  }

  /** Drops in-memory data older than retentionTime. Runs automatically while started. */
  cleanup(now = Date.now()) {
    const cutoff = now - this.config.retentionTime;
    this._recent.dropWhile((e) => e.ts < cutoff);
    this._logs.dropWhile((e) => e.ts < cutoff);
    this._errors.cleanup(cutoff);
    this._endpoints.cleanup(cutoff);
    if (this._limiter) this._limiter.cleanup(now);
    if (this._dups) this._dups.cleanup(now, cutoff);
  }

  // ---- request tracking --------------------------------------------------
  /**
   * Track a Node.js http request/response pair.
   * @returns {boolean} false if the request was rejected with 429 (response already ended) —
   *                    the caller must then NOT write to `res`.
   */
  track(req, res, opts = {}) {
    const cfg = this.config;
    if (!cfg.enabled) return true;
    if (!req || !res || typeof res.once !== 'function' || !req.headers) {
      throw new TypeError('node-api-watch: track(req, res) requires Node.js http request and response objects');
    }
    const existing = this._contexts.get(req);
    if (existing) return existing.allowed;

    const now = Date.now();
    const parsed = parseUrl(req.url || '/');
    const ctx = {
      id: createRequestId(req, cfg.trustIncomingRequestId),
      start: performance.now(), startWall: now, allowed: true, done: false,
      method: String(req.method || 'GET').toUpperCase().slice(0, 16),
      pathname: parsed.pathname,
      endpointPath: cfg.normalizePaths ? normalizePath(parsed.pathname) : parsed.pathname,
      searchParams: parsed.searchParams,
      ip: getClientIp(req, cfg.trustProxy),
      socket: res.socket || null,
      socketBytes0: res.socket ? res.socket.bytesWritten : 0,
    };
    this._contexts.set(req, ctx);

    if (cfg.requestIdHeader) { try { res.setHeader(cfg.requestIdHeader, ctx.id); } catch { /* headers already sent */ } }

    // Attach completion listeners BEFORE any early response so 429s are recorded too.
    res.once('finish', () => this._complete(ctx, req, res, false));
    res.once('close', () => this._complete(ctx, req, res, !res.writableFinished));

    if (this._limiter) this._applyRateLimit(ctx, req, res, opts);

    this._safeEmit('request', {
      requestId: ctx.id, method: ctx.method, path: ctx.pathname, ip: cfg.recordIp ? ctx.ip : null,
      timestamp: new Date(now).toISOString()
    });

    if (this._dups && ctx.allowed) {
      try { this._dups.record(ctx.ip || 'unknown', ctx.method, ctx.endpointPath, now); } catch (e) { this._internalError(e); }
    }
    return ctx.allowed;
  }

  _applyRateLimit(ctx, req, res, opts) {
    const rl = this.config.rateLimit;
    try {
      let key;
      if (typeof rl.keyBy === 'function') key = rl.keyBy(req, { ip: ctx.ip, method: ctx.method, path: ctx.endpointPath });
      else if (rl.keyBy === 'ip+endpoint') key = `${ctx.ip || 'unknown'}|${ctx.method} ${ctx.endpointPath}`;
      else key = ctx.ip || 'unknown';
      if (key === null || key === undefined) return; // custom keyBy opted this request out
      const r = this._limiter.check(String(key), ctx.startWall);
      if (rl.headers) {
        try {
          res.setHeader('X-RateLimit-Limit', r.limit);
          res.setHeader('X-RateLimit-Remaining', r.remaining);
          res.setHeader('X-RateLimit-Reset', Math.ceil(r.resetAt / 1000));
        } catch { /* headers already sent */ }
      }
      if (!r.limited) return;
      ctx.limited = true;
      this._safeEmit('rateLimitExceeded', {
        requestId: ctx.id, key: String(key), method: ctx.method, path: ctx.pathname,
        limit: r.limit, windowMs: rl.windowMs, retryAfter: r.retryAfter, enforced: rl.enforce && !opts.observeOnly
      });
      if (rl.enforce && !opts.observeOnly) {
        ctx.allowed = false;
        const body = JSON.stringify({ error: 'Too Many Requests', retryAfter: r.retryAfter });
        res.statusCode = 429;
        res.setHeader('Retry-After', r.retryAfter);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Length', Buffer.byteLength(body));
        res.end(body);
      }
    } catch (e) {
      this._internalError(e); // fail open: a limiter bug must not take the API down
    }
  }

  _complete(ctx, req, res, closedEarly) {
    if (ctx.done) return;
    ctx.done = true;
    try {
      const cfg = this.config;
      const duration = round(performance.now() - ctx.start);
      const statusCode = res.statusCode;
      const info = { method: ctx.method, path: ctx.pathname };

      let category;
      if (closedEarly) category = 'aborted';
      else {
        if (cfg.classify) { try { category = cfg.classify(statusCode, info); } catch { category = undefined; } }
        if (!CATEGORIES.includes(category)) category = defaultClassify(statusCode);
      }

      const query = cfg.captureQuery ? sanitizeQuery(ctx.searchParams, cfg._isSensitiveParam) : null;
      const clHeader = parseInt(req.headers['content-length'], 10);
      const resHeader = parseInt(res.getHeader('content-length'), 10);
      let responseSize = Number.isFinite(resHeader) ? resHeader : null;
      if (responseSize === null && ctx.socket) responseSize = Math.max(0, ctx.socket.bytesWritten - ctx.socketBytes0);
      const slow = cfg.performance && duration > cfg.slowRequestThreshold;

      const record = {
        requestId: ctx.id,
        timestamp: new Date(ctx.startWall).toISOString(),
        method: ctx.method,
        url: ctx.pathname + (query ? queryToString(query) : ''),
        path: ctx.pathname,
        endpoint: `${ctx.method} ${ctx.endpointPath}`,
        query,
        statusCode,
        duration,
        requestSize: Number.isFinite(clHeader) && clHeader >= 0 ? clHeader : null,
        responseSize,
        ip: cfg.recordIp ? ctx.ip : null,
        userAgent: req.headers['user-agent'] ? truncate(req.headers['user-agent'], 200) : null,
        contentType: req.headers['content-type'] ? truncate(req.headers['content-type'], 100) : null,
        httpVersion: req.httpVersion,
        result: RESULT_LABEL[category],
        category,
        slow,
        aborted: category === 'aborted',
        rateLimited: ctx.limited === true,
      };
      if (cfg.captureHeaders) record.headers = redactHeaderMap(req.headers, cfg._redactHeaderSet);

      const now = Date.now();
      this._stats.record(category);
      if (cfg.performance) this._perf.record(duration, slow);
      this._endpoints.record(ctx.method, ctx.endpointPath, category, duration, now);
      this._recent.push({ ts: now, duration, category });
      if (cfg.requestLogs) this._logs.push({ ts: now, data: record });
      this._logger.log(record);

      // Errors: HTTP 4xx/5xx, aborted connections, and errors captured via captureError().
      const captured = this._reqErrors.get(req);
      let errorEntry = null;
      if (captured || category === 'clientError' || category === 'serverError' || category === 'aborted') {
        let type; let message;
        if (captured) { type = captured.name || 'Error'; message = scrub(captured.message || String(captured)); }
        else if (category === 'aborted') { type = 'Aborted'; message = 'Client closed the connection before the response completed'; }
        else { type = category === 'clientError' ? 'ClientError' : 'ServerError'; message = `HTTP ${statusCode} ${http.STATUS_CODES[statusCode] || ''}`.trim(); }
        errorEntry = {
          timestamp: record.timestamp, requestId: ctx.id, endpoint: record.endpoint, method: ctx.method,
          path: ctx.pathname, status: statusCode, message, type, duration
        };
        this._errors.record(errorEntry);
        this._safeEmit('requestError', { ...record, error: { type, message } });
      }

      this._safeEmit('requestComplete', record);
      if (slow) this._safeEmit('slowRequest', { ...record, threshold: cfg.slowRequestThreshold });
      if (this._channel.hasSubscribers) this._channel.publish(record);
    } catch (e) {
      this._internalError(e);
    }
  }

  /** Attach an application error to the request so it appears in getErrors() (message is scrubbed). */
  captureError(req, err) {
    if (req && typeof req === 'object') this._reqErrors.set(req, err instanceof Error ? err : new Error(String(err)));
  }

  /** Returns the request ID assigned to `req` (undefined if not tracked). */
  getRequestId(req) { const c = req && this._contexts.get(req); return c ? c.id : undefined; }

  /** Request ID of the current async context (needs asyncContext: true + wrap()/middleware()). */
  getCurrentRequestId() { const s = this._als && this._als.getStore(); return s ? s.requestId : undefined; }

  /** Wraps a (req, res) handler: tracks, enforces rate limit, and sets the async context. */
  wrap(handler) {
    if (typeof handler !== 'function') throw new TypeError('node-api-watch: wrap(handler) requires a function');
    return (req, res, ...rest) => {
      if (!this.track(req, res)) return undefined;
      if (this._als) return this._als.run({ requestId: this.getRequestId(req) }, () => handler(req, res, ...rest));
      return handler(req, res, ...rest);
    };
  }

  /** Connect/Express-style middleware (no framework dependency). */
  middleware() {
    return (req, res, next) => {
      if (!this.track(req, res)) return;
      if (typeof next !== 'function') return;
      if (this._als) this._als.run({ requestId: this.getRequestId(req) }, next); else next();
    };
  }

  // ---- data access -------------------------------------------------------
  getRequestStats() { return this._stats.snapshot(); }

  getPerformanceStats() { return this._perf.getStats(this._recent); }

  getEndpointStats(options) { return this._endpoints.list(options); }

  getErrors(limit = 100) { return this._errors.list(limit); }

  get deviceinfo() {
  return this.getDeviceInfo();
}

  /** Newest first. Empty when requestLogs is false. */
  getRequestLogs(limit = 100) {
    const out = [];
    for (let i = this._logs.size - 1; i >= 0 && out.length < limit; i--) out.push(this._logs.get(i).data);
    return out;
  }

  getRateLimitStats() {
    return this._limiter ? this._limiter.getStats() : { enabled: false };
  }

  getRepeatedRequests() { return this._dups ? this._dups.list() : []; }

  getSystemStats() { return this._system.getStats(); }

  getCpuUsage() { return this._system.getCpuUsage(); }

  /**
   * Threshold-based health summary. "healthy" only means: none of the configured checks
   * (CPU, memory, recent 5xx rate) crossed its threshold. It is NOT a guarantee of correctness.
   */
  health() {
    const cfg = this.config;
    const now = Date.now();
    const sys = this._system.getStats();
    const checks = [];

    const cpu = sys.cpu.usage.systemPercent;
    checks.push({
      name: 'cpu', value: cpu, threshold: cfg.cpuThreshold, unit: '%',
      status: cpu === null ? 'unknown' : cpu >= cfg.cpuThreshold ? 'fail' : 'pass'
    });

    const memValue = Math.max(sys.memory.usedPercent, sys.memory.heapUsedPercent);
    checks.push({
      name: 'memory', value: memValue, threshold: cfg.memoryThreshold, unit: '%',
      detail: { systemUsedPercent: sys.memory.usedPercent, heapUsedPercent: sys.memory.heapUsedPercent },
      status: memValue >= cfg.memoryThreshold ? 'fail' : 'pass'
    });

    let n = 0; let errs = 0;
    for (let i = this._recent.size - 1; i >= 0; i--) {
      const e = this._recent.get(i);
      if (e.ts < now - cfg.healthWindow) break;
      n++; if (e.category === 'serverError') errs++;
    }
    const rate = n >= cfg.healthMinRequests ? round((errs / n) * 100) : null;
    checks.push({
      name: 'errorRate', value: rate, threshold: cfg.errorRateThreshold, unit: '%',
      detail: { requestsInWindow: n, serverErrorsInWindow: errs, windowMs: cfg.healthWindow, minRequests: cfg.healthMinRequests },
      status: rate === null ? 'unknown' : rate >= cfg.errorRateThreshold ? 'fail' : 'pass'
    });

    const failing = checks.filter((c) => c.status === 'fail').length;
    return {
      status: failing === 0 ? 'healthy' : failing === 1 ? 'degraded' : 'unhealthy',
      timestamp: new Date(now).toISOString(),
      uptime: round(process.uptime()),
      checks,
      memory: sys.memory, cpu: sys.cpu.usage,
      requests: this._stats.snapshot(),
      errors: { stored: this._errors.ring.size, totalRecorded: this._errors.total },
      definition: 'healthy = no configured check failed; degraded = 1 failed; unhealthy = 2+ failed; "unknown" checks (no data yet) are ignored.',
    };
  }

  // ---- reports -----------------------------------------------------------
  _buildReport() {
    const sys = this._system.getStats();
    return {
      generatedAt: new Date().toISOString(),
      version: VERSION,
      monitoringSince: new Date(this._startedAt).toISOString(),
      requests: this._stats.snapshot(),
      performance: this._perf.getStats(this._recent),
      endpoints: this._endpoints.list({ limit: 50 }),
      errors: { totalRecorded: this._errors.total, recent: this._errors.list(50) },
      rateLimit: this.getRateLimitStats(),
      repeatedRequests: this.getRepeatedRequests(),
      system: { cpu: sys.cpu, memory: sys.memory, process: sys.process },
      runtime: sys.runtime,
    };
  }

  getReport() {
    const report = this._buildReport();
    this._safeEmit('reportGenerated', report);
    return report;
  }

  /** JSON string of the report. */
  exportReport({ pretty = true } = {}) { return JSON.stringify(this.getReport(), null, pretty ? 2 : 0); }

  /** Writes the JSON report to `file` (async, mode 0600). Resolves to the absolute path. */
  async saveReport(file, options) {
    if (typeof file !== 'string' || !file) throw new TypeError('node-api-watch: saveReport(file) requires a file path');
    const abs = path.resolve(file);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, this.exportReport(options), { mode: 0o600 });
    return abs;
  }

  // ---- events / internals ------------------------------------------------
  _safeEmit(name, data) {
    if (this.listenerCount(name) === 0) return;
    try { this.emit(name, data); }
    catch (e) { process.emitWarning(`node-api-watch: listener for "${name}" threw: ${e && e.message}`); }
  }

  _internalError(err) {
    if (this.listenerCount('error') > 0) { try { this.emit('error', err); } catch { /* ignore */ } }
    else process.emitWarning(`node-api-watch: ${err && err.message ? err.message : err}`);
  }

  _recordProcessError(reason, type) {
    const isErr = util.types.isNativeError(reason);
    const entry = {
      timestamp: new Date().toISOString(), requestId: this.getCurrentRequestId() || null, endpoint: null,
      method: null, path: null, status: null, duration: null, type: isErr ? (reason.name || type) : type,
      message: scrub(isErr ? reason.message : (typeof reason === 'string' ? reason : util.inspect(reason, { depth: 0 })))
    };
    this._errors.record(entry);
    this._safeEmit('requestError', { error: { type: entry.type, message: entry.message }, processLevel: true, ...entry });
  }

  _installProcessHooks() {
    // 'uncaughtExceptionMonitor' observes without changing Node's default crash behaviour.
    this._onUncaught = (err) => this._recordProcessError(err, 'UncaughtException');
    process.on('uncaughtExceptionMonitor', this._onUncaught);
    // Adding an 'unhandledRejection' listener suppresses Node's default crash, so when we are the
    // only listener we re-throw to reproduce the default ("throw") behaviour.
    this._onRejection = (reason) => {
      this._recordProcessError(reason, 'UnhandledRejection');
      if (process.listenerCount('unhandledRejection') === 1) {
        setImmediate(() => { throw (util.types.isNativeError(reason) ? reason : new Error(util.inspect(reason, { depth: 0 }))); });
      }
    };
    process.on('unhandledRejection', this._onRejection);
  }

  _removeProcessHooks() {
    if (this._onUncaught) process.removeListener('uncaughtExceptionMonitor', this._onUncaught);
    if (this._onRejection) process.removeListener('unhandledRejection', this._onRejection);
    this._onUncaught = null; this._onRejection = null;
  }
}

// ============================================================================
// 13. EXPORTS
// ============================================================================
// `require('node-api-watch')` is the class AND offers a lazily-created default
// instance through static forwarding, so both documented styles work:
//   const Watch = require('node-api-watch'); new Watch(opts).start();
//   const monitor = require('node-api-watch'); monitor.start();
let defaultInstance = null;
const getDefault = () => { if (!defaultInstance) defaultInstance = new NodeApiWatch(); return defaultInstance; };

const FORWARDED = ['start', 'stop', 'reset', 'cleanup', 'track', 'wrap', 'middleware', 'captureError',
  'getRequestId', 'getCurrentRequestId', 'getRequestStats', 'getEndpointStats', 'getPerformanceStats',
  'getErrors', 'getRequestLogs', 'getSystemStats', 'getRateLimitStats', 'getRepeatedRequests', 'getReport',
  'getCpuUsage', 'health', 'exportReport', 'saveReport', 'on', 'once', 'off', 'addListener', 'removeListener' , 'getDeviceInfo'];

for (const name of FORWARDED) {
  Object.defineProperty(NodeApiWatch, name, {
    value: (...args) => { const inst = getDefault(); const out = inst[name](...args); return out === inst ? inst : out; },
    writable: true, configurable: true,
  });
}

/** Replace the default instance with one using custom options. */
NodeApiWatch.configure = (options) => {
  if (defaultInstance) defaultInstance.stop();
  defaultInstance = new NodeApiWatch(options);
  return defaultInstance;
};
NodeApiWatch.getDefault = getDefault;
NodeApiWatch.NodeApiWatch = NodeApiWatch;
NodeApiWatch.default = NodeApiWatch;
NodeApiWatch.VERSION = VERSION;
/** Unstable helpers exposed for the test-suite only. Not part of the public API. */
NodeApiWatch._internals = { computeCpuUsage, normalizePath, percentile, scrub, RingBuffer, MemoryStore, normalizeConfig };

module.exports = NodeApiWatch;
Object.defineProperty(NodeApiWatch, 'deviceinfo', {
  configurable: true,
  get: () => getDefault().deviceinfo
});
// ============================================================================
// 14. CLI                     (FUTURE SPLIT: bin/node-api-watch.js)
// ============================================================================
const HELP = `node-api-watch v${VERSION}

Usage:
  node-api-watch --help      Show this help
  node-api-watch --version   Print the version
  node-api-watch system      Print CPU / memory / process / runtime stats as JSON
  node-api-watch report      Print a full JSON report

Note: the CLI is a separate process, so "report" contains system data only;
request metrics come from the monitor running inside your application.`;

async function runCli(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return; }
  if (cmd === '--version' || cmd === '-v') { console.log(VERSION); return; }
  if (cmd === 'system' || cmd === 'report') {
    const monitor = new NodeApiWatch();
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 1100)); // let CPU sampling collect a real window
    const out = cmd === 'system' ? monitor.getSystemStats() : monitor.getReport();
    if (cmd === 'report') out.note = 'Standalone CLI process: request metrics are empty because it is not attached to your application.';
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    await monitor.stop();
    return;
  }
  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exitCode = 1;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exitCode = 1; });
}
