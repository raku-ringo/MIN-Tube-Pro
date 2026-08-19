'use strict';

const { fetchWithTimeout, fetchJson, mapPool } = require('./http');

const REMOTE_LIST_URLS = [
  process.env.API_LIST_URL || 'https://raw.githubusercontent.com/Minotaur-ZAOU/test/refs/heads/main/min-tube-api.json',
  'https://cdn.jsdelivr.net/gh/Minotaur-ZAOU/test@main/min-tube-api.json'
];

const PROBE_VIDEO = 'jNQXAC9IVRw';

const SEED_SOURCES = [
  { id: 'sia-meta', type: 'sia', base: 'https://siawaseok.duckdns.org' },
  { id: 'inv-choco', type: 'invidious', base: 'https://yt.chocolatemoo53.com' },
  { id: 'inv-f5', type: 'invidious', base: 'https://invidious.f5.si' },
  { id: 'inv-nerd', type: 'invidious', base: 'https://invidious.nerdvpn.de' },
  { id: 'inv-nadeko', type: 'invidious', base: 'https://inv.nadeko.net' },
  { id: 'inv-tiekoetter', type: 'invidious', base: 'https://invidious.tiekoetter.com' },
  { id: 'inv-pixora', type: 'invidious', base: 'https://inv.thepixora.com' },
  { id: 'piped-kavin', type: 'piped', base: 'https://pipedapi.kavin.rocks' },
  { id: 'piped-adminforge', type: 'piped', base: 'https://pipedapi.adminforge.de' },
  { id: 'piped-lunar', type: 'piped', base: 'https://pipedapi.lunar.icu' },
  { id: 'piped-tokhmi', type: 'piped', base: 'https://pipedapi.tokhmi.xyz' }
];

const COOLDOWN_MS = 8 * 60 * 1000;
const FAIL_THRESHOLD = 3;
const HEALTH_INTERVAL_MS = 2 * 60 * 1000;

function stripSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function sourceId(type, base) {
  return `${type}:${stripSlash(base)}`;
}

function normalizeRemoteList(data) {
  const out = [];
  const push = (item) => {
    if (!item) return;
    if (typeof item === 'string') {
      const base = stripSlash(item);
      if (/^https?:\/\//i.test(base)) out.push({ type: guessType(base), base });
      return;
    }
    if (typeof item !== 'object') return;
    const base = stripSlash(item.url || item.base || item.host || item.api || item.href);
    if (!base || !/^https?:\/\//i.test(base)) return;
    out.push({
      type: item.type || item.kind || guessType(base),
      base
    });
  };

  if (Array.isArray(data)) {
    data.forEach(push);
  } else if (data && typeof data === 'object') {
    if (Array.isArray(data.apis)) data.apis.forEach(push);
    else if (Array.isArray(data.instances)) data.instances.forEach(push);
    else if (Array.isArray(data.list)) data.list.forEach(push);
    else Object.values(data).forEach(push);
  }
  return out;
}

function guessType(base) {
  const host = base.toLowerCase();
  if (host.includes('piped')) return 'piped';
  if (host.includes('invidious') || host.includes('inv.') || host.includes('yewtu') || host.includes('vid.puffyan')) {
    return 'invidious';
  }
  if (host.includes('siawaseok')) return 'sia';
  return 'mintube';
}

function createEntry(src) {
  return {
    id: src.id || sourceId(src.type, src.base),
    type: src.type || 'mintube',
    base: stripSlash(src.base),
    alive: false,
    latency: null,
    failCount: 0,
    successCount: 0,
    lastCheck: 0,
    lastSuccess: 0,
    lastError: '',
    cooldownUntil: 0
  };
}

const pool = new Map();

function upsertSource(src) {
  const id = src.id || sourceId(src.type, src.base);
  const existing = pool.get(id);
  if (existing) return existing;
  const entry = createEntry({ ...src, id });
  pool.set(id, entry);
  return entry;
}

SEED_SOURCES.forEach(upsertSource);

function scoreOf(entry) {
  if (!entry.alive) return -1;
  const latency = entry.latency == null ? 2500 : entry.latency;
  return 12000 / (latency + 40) + entry.successCount * 0.15 - entry.failCount * 8;
}

function inCooldown(entry) {
  return entry.failCount >= FAIL_THRESHOLD && Date.now() < entry.cooldownUntil;
}

async function probeEntry(entry) {
  if (inCooldown(entry) && Date.now() - entry.lastCheck < 30000) {
    return entry;
  }
  const started = Date.now();
  entry.lastCheck = started;
  try {
    const ok = await probeByType(entry);
    const ms = Date.now() - started;
    if (ok) {
      entry.alive = true;
      entry.latency = entry.latency == null ? ms : Math.round(entry.latency * 0.55 + ms * 0.45);
      entry.failCount = 0;
      entry.successCount += 1;
      entry.lastSuccess = Date.now();
      entry.lastError = '';
      entry.cooldownUntil = 0;
    } else {
      markDead(entry, `probe rejected (${ms}ms)`);
    }
  } catch (err) {
    markDead(entry, err.message || String(err));
  }
  return entry;
}

function markDead(entry, reason) {
  entry.alive = false;
  entry.failCount += 1;
  entry.lastError = String(reason || 'failed').slice(0, 180);
  if (entry.failCount >= FAIL_THRESHOLD) {
    entry.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
}

function markSoftFail(entry, reason) {
  if (!entry) return;
  entry.failCount += 1;
  entry.lastError = String(reason || 'request failed').slice(0, 180);
  if (entry.failCount >= FAIL_THRESHOLD) {
    entry.alive = false;
    entry.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
}

function markSuccess(entry, ms) {
  if (!entry) return;
  entry.alive = true;
  entry.failCount = 0;
  entry.successCount += 1;
  entry.lastSuccess = Date.now();
  if (typeof ms === 'number') {
    entry.latency = entry.latency == null ? ms : Math.round(entry.latency * 0.6 + ms * 0.4);
  }
}

async function probeByType(entry) {
  const { type, base } = entry;
  if (type === 'invidious') {
    try {
      const stats = await fetchJson(`${base}/api/v1/stats`, {}, 2500);
      return !!(stats && (stats.software || stats.totalUsers != null || stats.version));
    } catch (_) {
      const data = await fetchJson(`${base}/api/v1/videos/${PROBE_VIDEO}?fields=title,videoId`, {}, 3500);
      return !!(data && (data.title || data.videoId));
    }
  }
  if (type === 'piped') {
    try {
      const res = await fetchWithTimeout(`${base}/healthcheck`, {}, 2500);
      if (res.ok) return true;
    } catch (_) { /* fall through */ }
    const data = await fetchJson(`${base}/streams/${PROBE_VIDEO}`, {}, 4000);
    return !!(data && (data.title || (data.videoStreams && data.videoStreams.length)));
  }
  if (type === 'sia') {
    const data = await fetchJson(`${base}/api/video2/${PROBE_VIDEO}?depth=1`, {}, 4000);
    return !!(data && (data.title || data.id));
  }
  // mintube-style: /api/video/:id
  const data = await fetchJson(`${base}/api/video/${PROBE_VIDEO}`, {}, 4000);
  return !!(data && (data.stream_url || data.videoTitle || data.title));
}

async function refreshRemoteList() {
  for (const url of REMOTE_LIST_URLS) {
    try {
      const data = await fetchJson(url, { headers: { 'user-agent': 'MIN-Tube-Pro/1.5' } }, 5000);
      const list = normalizeRemoteList(data);
      for (const src of list) upsertSource(src);
      if (list.length) return list.length;
    } catch (_) { /* try next mirror */ }
  }
  return 0;
}

let refreshing = false;

async function refreshPool() {
  if (refreshing) return snapshot();
  refreshing = true;
  try {
    await refreshRemoteList();
    const entries = [...pool.values()].filter((e) => !inCooldown(e) || Date.now() - e.lastCheck > 60000);
    await mapPool(entries, 6, probeEntry);
    return snapshot();
  } finally {
    refreshing = false;
  }
}

function snapshot() {
  return [...pool.values()]
    .map((e) => ({
      id: e.id,
      type: e.type,
      base: e.base,
      alive: e.alive,
      latency: e.latency,
      failCount: e.failCount,
      successCount: e.successCount,
      lastCheck: e.lastCheck,
      lastSuccess: e.lastSuccess,
      lastError: e.lastError,
      cooldown: inCooldown(e),
      score: Number(scoreOf(e).toFixed(2))
    }))
    .sort((a, b) => b.score - a.score);
}

function getAlive(limit = 8, types = null) {
  const typeSet = types ? new Set(types) : null;
  return [...pool.values()]
    .filter((e) => e.alive && !inCooldown(e) && (!typeSet || typeSet.has(e.type)))
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, limit);
}

function getCandidates(limit = 10, types = null) {
  const alive = getAlive(limit, types);
  if (alive.length) return alive;
  // Startup / total outage: try everyone not in hard cooldown
  const typeSet = types ? new Set(types) : null;
  return [...pool.values()]
    .filter((e) => !inCooldown(e) && (!typeSet || typeSet.has(e.type)))
    .sort((a, b) => (a.latency || 9999) - (b.latency || 9999))
    .slice(0, limit);
}

function getEntry(id) {
  return pool.get(id);
}

function findByBase(base) {
  const key = stripSlash(base);
  for (const entry of pool.values()) {
    if (entry.base === key) return entry;
  }
  return null;
}

let started = false;
let timer = null;

function start(intervalMs = HEALTH_INTERVAL_MS) {
  if (started) return;
  started = true;
  refreshPool().catch(() => {});
  timer = setInterval(() => {
    refreshPool().catch(() => {});
  }, intervalMs);
  if (timer.unref) timer.unref();
}

function stop() {
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  start,
  stop,
  refreshPool,
  snapshot,
  getAlive,
  getCandidates,
  getEntry,
  findByBase,
  markSuccess,
  markSoftFail,
  upsertSource,
  SEED_SOURCES,
  PROBE_VIDEO
};
