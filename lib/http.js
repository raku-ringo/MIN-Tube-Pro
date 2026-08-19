'use strict';

const { fetch, Agent } = require('undici');

const agent = new Agent({
  connect: { timeout: 4000 },
  keepAliveTimeout: 15000,
  keepAliveMaxTimeout: 60000,
  connections: 64,
  pipelining: 1
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Abortable fetch with a hard timeout. Always clears the timer.
 */
async function fetchWithTimeout(url, options = {}, timeout = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      dispatcher: options.dispatcher || agent
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeout = 4000) {
  const res = await fetchWithTimeout(url, options, timeout);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchText(url, options = {}, timeout = 4000) {
  const res = await fetchWithTimeout(url, options, timeout);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/**
 * Run async tasks with a concurrency cap.
 */
async function mapPool(items, limit, iterator) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await iterator(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * First fulfilled promise, or last rejection if all fail.
 */
async function firstFulfilled(promises) {
  if (!promises.length) throw new Error('No candidates');
  return new Promise((resolve, reject) => {
    let pending = promises.length;
    let lastError = new Error('All candidates failed');
    for (const p of promises) {
      Promise.resolve(p).then(resolve, (err) => {
        lastError = err;
        pending -= 1;
        if (pending === 0) reject(lastError);
      });
    }
  });
}

class TtlCache {
  constructor(ttlMs = 120000, max = 200) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiry < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expiry: Date.now() + ttlMs });
    return value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    this.map.delete(key);
  }

  prune() {
    const now = Date.now();
    for (const [key, hit] of this.map) {
      if (hit.expiry < now) this.map.delete(key);
    }
  }
}

module.exports = {
  agent,
  sleep,
  fetchWithTimeout,
  fetchJson,
  fetchText,
  mapPool,
  firstFulfilled,
  TtlCache
};
