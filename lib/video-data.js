'use strict';

const yts = require('youtube-search-api');
const { fetchWithTimeout, fetchJson, fetchText, firstFulfilled, TtlCache } = require('./http');
const pool = require('./api-pool');

const RAPID_API_HOST = 'ytstream-download-youtube-videos.p.rapidapi.com';
const GETLATE_PREFIX = 'https://getlate.dev/api/tools/youtube-live-downloader?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D';
const GETLATE_SUFFIX = '&formatId=2';
const AIJIMY_PREFIX = 'https://api.aijimy.com/get?code=get-youtube-videodata&text=';

const keys = [
  process.env.RAPIDAPI_KEY_1,
  process.env.RAPIDAPI_KEY_2,
  process.env.RAPIDAPI_KEY_3
].filter(Boolean);

const videoCache = new TtlCache(3 * 60 * 1000, 250);
const commentCache = new TtlCache(3 * 60 * 1000, 250);
const streamUrlCache = new TtlCache(55 * 1000, 250);
const eduCache = new TtlCache(30 * 60 * 1000, 20);
const searchCache = new TtlCache(45 * 1000, 80);
const metaCache = new TtlCache(10 * 60 * 1000, 250);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function isValidId(id) {
  return /^[a-zA-Z0-9_-]{11}$/.test(String(id || ''));
}

function parseCount(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const str = String(value);
  const abbrev = str.match(/([\d,.]+)\s*([KMBkmb])/);
  if (abbrev) {
    const num = parseFloat(abbrev[1].replace(/,/g, ''));
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[abbrev[2].toLowerCase()] || 1;
    return Math.round(num * mult) || 0;
  }
  return parseInt(str.replace(/[^0-9]/g, ''), 10) || 0;
}

function pickThumb(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const last = list[list.length - 1];
  return last.url || last.src || '';
}

function normalizeVideo(partial) {
  const stream = String(partial.stream_url || '').trim();
  return {
    stream_url: stream || 'youtube-nocookie',
    highstreamUrl: partial.highstreamUrl || stream || '',
    audioUrl: partial.audioUrl || '',
    videoId: partial.videoId || '',
    channelId: partial.channelId || '',
    channelName: partial.channelName || 'YouTube',
    channelImage: partial.channelImage || '',
    videoTitle: partial.videoTitle || partial.videoId || 'Untitled',
    videoDes: partial.videoDes || '',
    videoViews: partial.videoViews || 0,
    likeCount: partial.likeCount || 0,
    provider: partial.provider || 'unknown',
    streamUrls: partial.streamUrls || [],
    audioUrls: partial.audioUrls || []
  };
}

function looksPlayable(data) {
  if (!data) return false;
  const url = data.stream_url;
  if (!url || url === 'youtube-nocookie') return false;
  return typeof url === 'string' && url.length > 8;
}

async function fetchMintube(base, videoId, timeout = 3800) {
  const data = await fetchJson(`${base}/api/video/${videoId}`, {}, timeout);
  const stream = data.stream_url || data.streamUrl || data.url || '';
  if (!stream && !data.videoTitle && !data.title) throw new Error('empty mintube');
  return normalizeVideo({
    stream_url: stream,
    highstreamUrl: data.highstreamUrl || data.highStreamUrl || stream,
    audioUrl: data.audioUrl || '',
    videoId: data.videoId || videoId,
    channelId: data.channelId || '',
    channelName: data.channelName || data.author || '',
    channelImage: data.channelImage || data.authorThumbnail || '',
    videoTitle: data.videoTitle || data.title || videoId,
    videoDes: data.videoDes || data.description || '',
    videoViews: parseCount(data.videoViews || data.viewCount),
    likeCount: parseCount(data.likeCount),
    provider: `mintube:${base}`
  });
}

async function fetchInvidious(base, videoId, timeout = 4000) {
  const data = await fetchJson(`${base}/api/v1/videos/${videoId}`, {}, timeout);
  if (!data || (!data.title && !data.formatStreams && !data.adaptiveFormats)) {
    throw new Error('empty invidious');
  }
  const progressive = (data.formatStreams || []).filter((f) => f.url);
  const adaptive = (data.adaptiveFormats || []).filter((f) => f.url);
  const videoOnly = adaptive.filter((f) => /^video\//.test(f.type || f.mimeType || ''));
  const audioOnly = adaptive.filter((f) => /^audio\//.test(f.type || f.mimeType || ''));
  const bestProg = progressive[progressive.length - 1] || progressive[0];
  const stream = (bestProg && bestProg.url) || (videoOnly[0] && videoOnly[0].url) || '';
  return normalizeVideo({
    stream_url: stream,
    highstreamUrl: (videoOnly[0] && videoOnly[0].url) || stream,
    audioUrl: (audioOnly[0] && audioOnly[0].url) || '',
    videoId,
    channelId: data.authorId || '',
    channelName: data.author || '',
    channelImage: pickThumb(data.authorThumbnails),
    videoTitle: data.title || videoId,
    videoDes: data.description || '',
    videoViews: parseCount(data.viewCount),
    likeCount: parseCount(data.likeCount),
    provider: `invidious:${base}`,
    streamUrls: progressive.map((f) => ({
      url: f.url,
      resolution: f.qualityLabel || f.resolution || '',
      container: f.container || ''
    })),
    audioUrls: audioOnly.map((f) => ({ url: f.url, container: f.container || '' }))
  });
}

async function fetchPiped(base, videoId, timeout = 4000) {
  const data = await fetchJson(`${base}/streams/${videoId}`, {}, timeout);
  if (!data || !data.title) throw new Error('empty piped');
  const videos = (data.videoStreams || []).filter((s) => s.url && !s.videoOnly);
  const videoOnly = (data.videoStreams || []).filter((s) => s.url && s.videoOnly);
  const audios = (data.audioStreams || []).filter((s) => s.url);
  const stream = (videos[0] && videos[0].url) || (videoOnly[0] && videoOnly[0].url) || '';
  return normalizeVideo({
    stream_url: stream,
    highstreamUrl: (videoOnly[0] && videoOnly[0].url) || stream,
    audioUrl: (audios[0] && audios[0].url) || '',
    videoId,
    channelId: '',
    channelName: data.uploader || '',
    channelImage: data.uploaderAvatar || '',
    videoTitle: data.title || videoId,
    videoDes: data.description || '',
    videoViews: parseCount(data.views),
    likeCount: parseCount(data.likes),
    provider: `piped:${base}`,
    streamUrls: (data.videoStreams || []).filter((s) => s.url).map((s) => ({
      url: s.url,
      resolution: s.quality || '',
      container: s.format || ''
    })),
    audioUrls: audios.map((s) => ({ url: s.url, container: s.format || '' }))
  });
}

async function fetchSiaMeta(videoId, timeout = 4000) {
  const data = await fetchJson(`https://siawaseok.duckdns.org/api/video2/${videoId}?depth=1`, {}, timeout);
  if (!data || !data.title) throw new Error('empty sia');
  let stream = '';
  try {
    stream = await resolve360(videoId);
  } catch (_) { /* metadata still useful */ }
  return normalizeVideo({
    stream_url: stream,
    highstreamUrl: stream,
    audioUrl: '',
    videoId: data.id || videoId,
    channelId: data.author?.id || '',
    channelName: data.author?.name || '',
    channelImage: data.author?.thumbnail || '',
    videoTitle: data.title,
    videoDes: data.description?.text || data.description || '',
    videoViews: parseCount(data.views || data.extended_stats?.views_original),
    likeCount: parseCount(data.likes),
    provider: 'sia'
  });
}

async function resolve360(videoId) {
  const cached = streamUrlCache.get(`360:${videoId}`);
  if (cached) return cached;
  const target = GETLATE_PREFIX + videoId + GETLATE_SUFFIX;
  const response = await fetchWithTimeout(target, {
    method: 'GET',
    headers: { 'user-agent': randomUA() },
    redirect: 'follow'
  }, 5000);
  const finalUrl = response.url || '';
  if (!finalUrl || finalUrl.includes('getlate.dev')) {
    const text = await response.text().catch(() => '');
    if (/^https?:\/\//.test(text.trim())) {
      streamUrlCache.set(`360:${videoId}`, text.trim());
      return text.trim();
    }
    throw new Error('360 unresolved');
  }
  streamUrlCache.set(`360:${videoId}`, finalUrl);
  return finalUrl;
}

async function fetchRapid(videoId, timeout = 4500) {
  if (!keys.length) throw new Error('no rapid key');
  const selectedKey = keys[Math.floor(Math.random() * keys.length)];
  const data = await fetchJson(`https://${RAPID_API_HOST}/dl?id=${videoId}`, {
    method: 'GET',
    headers: {
      'x-rapidapi-key': selectedKey,
      'x-rapidapi-host': RAPID_API_HOST
    }
  }, timeout);
  if (!data || data.status !== 'OK') throw new Error('rapid not ok');
  let channelImageUrl = data.channelThumbnail?.[0]?.url || data.author?.thumbnails?.[0]?.url || '';
  if (!channelImageUrl) {
    const name = encodeURIComponent(data.channelTitle || 'Youtube Channel');
    channelImageUrl = `https://ui-avatars.com/api/?name=${name}&background=random&color=fff&size=128`;
  }
  const highResStream = data.adaptiveFormats?.find((f) => f.qualityLabel === '1080p') || data.adaptiveFormats?.[0];
  const audioStream = data.adaptiveFormats?.find((f) => (f.mimeType || '').includes('audio')) || data.adaptiveFormats?.[data.adaptiveFormats?.length - 1];
  const stream = data.formats?.[0]?.url || '';
  if (!stream) throw new Error('rapid no stream');
  return normalizeVideo({
    stream_url: stream,
    highstreamUrl: highResStream?.url || stream,
    audioUrl: audioStream?.url || '',
    videoId: data.id || videoId,
    channelId: data.channelId || '',
    channelName: data.channelTitle || '',
    channelImage: channelImageUrl,
    videoTitle: data.title || videoId,
    videoDes: data.description || '',
    videoViews: parseCount(data.viewCount),
    likeCount: parseCount(data.likeCount),
    provider: 'rapid'
  });
}

async function fetchNoembedMeta(videoId) {
  const cached = metaCache.get(`noembed:${videoId}`);
  if (cached) return cached;
  const data = await fetchJson(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`, {}, 3000);
  if (!data || data.error) throw new Error('noembed failed');
  const meta = {
    videoTitle: data.title || videoId,
    channelName: data.author_name || 'YouTube',
    channelImage: ''
  };
  metaCache.set(`noembed:${videoId}`, meta);
  return meta;
}

async function fetchAijimy(videoId, timeout = 4500) {
  const textData = await fetchText(AIJIMY_PREFIX + videoId, {}, timeout);
  const descriptionMatch = textData.match(/概要欄:\s*([\s\S]*?)\s*公開日:/);
  const viewsMatch = textData.match(/再生回数:\s*(\d+)/);
  const likesMatch = textData.match(/高評価数:\s*(\d+)/);
  let videoTitle = videoId;
  let channelName = 'YouTube';
  try {
    const meta = await fetchNoembedMeta(videoId);
    videoTitle = meta.videoTitle;
    channelName = meta.channelName;
  } catch (_) { /* keep ids */ }

  let stream = '';
  try {
    stream = await resolve360(videoId);
  } catch (_) { /* nocookie fallback later */ }

  return normalizeVideo({
    stream_url: stream,
    highstreamUrl: stream,
    audioUrl: stream,
    videoId,
    channelName,
    channelImage: `https://ui-avatars.com/api/?name=${encodeURIComponent(channelName)}&background=random&color=fff&size=128`,
    videoTitle,
    videoDes: descriptionMatch ? descriptionMatch[1].trim() : '',
    videoViews: viewsMatch ? parseInt(viewsMatch[1], 10) : 0,
    likeCount: likesMatch ? parseInt(likesMatch[1], 10) : 0,
    provider: 'aijimy'
  });
}

async function fetchInvCompanion(videoId) {
  const cached = streamUrlCache.get(`inv:${videoId}`);
  if (cached) {
    return normalizeVideo({ stream_url: cached, videoId, videoTitle: videoId, provider: 'inv-companion' });
  }
  let extraParams = eduCache.get('inv-extra') || '';
  if (!extraParams) {
    try {
      extraParams = (await fetchText('https://raw.githubusercontent.com/mino-hobby-pro/min-tube-pro-local-txt/refs/heads/main/inv-check.txt', {}, 2500)).trim();
      eduCache.set('inv-extra', extraParams);
    } catch (_) {
      extraParams = '';
    }
  }
  const targetUrl = `https://yt-comp5.chocolatemoo53.com/companion/latest_version?id=${videoId}${extraParams}`;
  const response = await fetchWithTimeout(targetUrl, {
    method: 'GET',
    headers: { 'user-agent': randomUA(), accept: '*/*' },
    redirect: 'follow'
  }, 4500);
  if (!response.ok) throw new Error(`inv companion ${response.status}`);
  const finalUrl = response.url;
  if (!finalUrl) throw new Error('inv companion empty');
  streamUrlCache.set(`inv:${videoId}`, finalUrl);
  let meta = { videoTitle: videoId, channelName: 'YouTube' };
  try { meta = await fetchNoembedMeta(videoId); } catch (_) { /* ignore */ }
  return normalizeVideo({
    stream_url: finalUrl,
    highstreamUrl: finalUrl,
    videoId,
    videoTitle: meta.videoTitle,
    channelName: meta.channelName,
    provider: 'inv-companion'
  });
}

async function fetchNocookieFallback(videoId) {
  let meta = { videoTitle: videoId, channelName: 'YouTube' };
  try { meta = await fetchNoembedMeta(videoId); } catch (_) {
    try {
      const results = await yts.GetListByKeyword(videoId, false, 8);
      const hit = (results.items || []).find((item) => item.id === videoId);
      if (hit) {
        meta = { videoTitle: hit.title || videoId, channelName: hit.channelTitle || 'YouTube' };
      }
    } catch (_) { /* last resort titles */ }
  }
  return normalizeVideo({
    stream_url: 'youtube-nocookie',
    videoId,
    videoTitle: meta.videoTitle,
    channelName: meta.channelName,
    channelImage: `https://ui-avatars.com/api/?name=${encodeURIComponent(meta.channelName)}&background=random&color=fff&size=128`,
    provider: 'nocookie'
  });
}

async function runAdapter(entry, videoId) {
  const started = Date.now();
  try {
    let data;
    if (entry.type === 'invidious') data = await fetchInvidious(entry.base, videoId);
    else if (entry.type === 'piped') data = await fetchPiped(entry.base, videoId);
    else if (entry.type === 'sia') data = await fetchSiaMeta(videoId);
    else data = await fetchMintube(entry.base, videoId);
    pool.markSuccess(entry, Date.now() - started);
    return data;
  } catch (err) {
    pool.markSoftFail(entry, err.message);
    throw err;
  }
}

function timed(promise, timeout, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeout);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Race every surviving provider. Prefer a real stream_url; fall back to nocookie metadata.
 */
async function getVideoData(videoId) {
  if (!isValidId(videoId)) throw new Error('invalid id');
  const cached = videoCache.get(videoId);
  if (cached) return cached;

  const candidates = pool.getCandidates(8);
  const racers = [];

  for (const entry of candidates) {
    racers.push(timed(runAdapter(entry, videoId).then((data) => {
      if (!looksPlayable(data)) throw new Error('no stream');
      return data;
    }), 4200, entry.id));
  }

  racers.push(timed(fetchRapid(videoId).then((data) => {
    if (!looksPlayable(data)) throw new Error('rapid no stream');
    return data;
  }), 4500, 'rapid'));

  racers.push(timed(fetchSiaMeta(videoId).then((data) => {
    if (!looksPlayable(data)) throw new Error('sia no stream');
    return data;
  }), 4500, 'sia-direct'));

  racers.push(timed(fetchInvCompanion(videoId).then((data) => {
    if (!looksPlayable(data)) throw new Error('inv no stream');
    return data;
  }), 4500, 'inv-companion'));

  racers.push(timed(resolve360(videoId).then(async (url) => {
    if (!url) throw new Error('360 empty');
    let meta = { videoTitle: videoId, channelName: 'YouTube' };
    try { meta = await fetchNoembedMeta(videoId); } catch (_) { /* ignore */ }
    return normalizeVideo({
      stream_url: url,
      highstreamUrl: url,
      videoId,
      videoTitle: meta.videoTitle,
      channelName: meta.channelName,
      provider: 'dl360'
    });
  }), 5000, 'dl360'));

  racers.push(timed(fetchAijimy(videoId).then((data) => {
    if (!looksPlayable(data)) throw new Error('aijimy no stream');
    return data;
  }), 5000, 'aijimy'));

  let data;
  try {
    data = await firstFulfilled(racers);
  } catch (_) {
    data = await fetchNocookieFallback(videoId);
  }

  if (!data.channelImage && data.channelName) {
    data.channelImage = `https://ui-avatars.com/api/?name=${encodeURIComponent(data.channelName)}&background=random&color=fff&size=128`;
  }
  videoCache.set(videoId, data);
  return data;
}

async function getComments(videoId) {
  if (!isValidId(videoId)) return { commentCount: 0, comments: [] };
  const cached = commentCache.get(videoId);
  if (cached) return cached;

  const mintube = pool.getCandidates(5, ['mintube']);
  const invidious = pool.getCandidates(5, ['invidious']);
  const racers = [];

  for (const entry of mintube) {
    racers.push((async () => {
      const data = await fetchJson(`${entry.base}/api/comments/${videoId}`, {}, 3000);
      if (!data || (!data.comments && data.commentCount == null)) throw new Error('empty comments');
      return {
        commentCount: data.commentCount || (data.comments || []).length || 0,
        comments: Array.isArray(data.comments) ? data.comments : []
      };
    })());
  }

  for (const entry of invidious) {
    racers.push((async () => {
      const data = await fetchJson(`${entry.base}/api/v1/comments/${videoId}`, {}, 3000);
      const comments = (data.comments || []).map((c) => ({
        author: c.author,
        content: c.content,
        authorThumbnails: c.authorThumbnails || []
      }));
      return { commentCount: data.commentCount || comments.length, comments };
    })());
  }

  if (!racers.length) return { commentCount: 0, comments: [] };

  try {
    const data = await firstFulfilled(racers.map((p) => timed(p, 3200, 'comments')));
    commentCache.set(videoId, data);
    return data;
  } catch (_) {
    return { commentCount: 0, comments: [] };
  }
}

function normalizeSearchItem(item) {
  if (!item) return null;
  const id = item.videoId || item.id || item.url?.split("v=")[1] || "";
  if (!id || String(id).startsWith("UC")) return null;
  return {
    id: String(id),
    type: item.type === "channel" ? "channel" : "video",
    title: item.title || item.name || "",
    channelTitle: item.author || item.uploaderName || item.channelTitle || item.owner || "",
    lengthText: item.length || item.duration || item.lengthText || "",
    viewCountText: item.viewCountText || (item.viewCount != null ? String(item.viewCount) : item.views != null ? String(item.views) : ""),
    thumbnail: item.videoThumbnails || item.thumbnail || item.thumbnails
  };
}

async function searchInvidious(query, page = 0) {
  const instances = pool.getCandidates(5, ["invidious"]);
  const bases = instances.length
    ? instances.map((e) => e.base)
    : ["https://yt.chocolatemoo53.com", "https://invidious.f5.si", "https://inv.nadeko.net"];
  const racers = bases.map(async (base) => {
    const data = await fetchJson(
      `${base}/api/v1/search?q=${encodeURIComponent(query)}&page=${page + 1}&type=video`,
      {},
      4000
    );
    const items = (Array.isArray(data) ? data : []).map(normalizeSearchItem).filter(Boolean);
    if (!items.length) throw new Error("empty inv search");
    return { items };
  });
  return firstFulfilled(racers);
}

async function searchPiped(query) {
  const instances = pool.getCandidates(4, ["piped"]);
  const bases = instances.length
    ? instances.map((e) => e.base)
    : ["https://pipedapi.kavin.rocks", "https://pipedapi.adminforge.de"];
  const racers = bases.map(async (base) => {
    const data = await fetchJson(`${base}/search?q=${encodeURIComponent(query)}&filter=videos`, {}, 4000);
    const raw = data.items || data;
    const items = (Array.isArray(raw) ? raw : []).map((it) => normalizeSearchItem({
      videoId: it.url ? String(it.url).replace("/watch?v=", "") : it.id,
      title: it.title,
      uploaderName: it.uploaderName,
      duration: it.duration,
      views: it.views
    })).filter(Boolean);
    if (!items.length) throw new Error("empty piped search");
    return { items };
  });
  return firstFulfilled(racers);
}

async function searchVideos(query, page = 0) {
  const key = `s:${page}:${query}`;
  const cached = searchCache.get(key);
  if (cached) return cached;

  const racers = [
    yts.GetListByKeyword(query, false, 20, page).then((results) => {
      if (!results || !Array.isArray(results.items) || !results.items.length) {
        throw new Error("empty yts");
      }
      return results;
    })
  ];
  if (page === 0) {
    racers.push(searchInvidious(query, page));
    racers.push(searchPiped(query));
  } else {
    racers.push(searchInvidious(query, page));
  }

  try {
    const results = await firstFulfilled(racers.map((p) => timed(p, 5000, "search")));
    searchCache.set(key, results);
    return results;
  } catch (_) {
    const empty = { items: [] };
    searchCache.set(key, empty, 8000);
    return empty;
  }
}

const apiHandlers = {
  mintube: async (videoId) => {
    const entry = pool.getCandidates(1, ['mintube'])[0];
    if (!entry) throw new Error('no mintube');
    return runAdapter(entry, videoId);
  },
  invidious: async (videoId) => {
    const entry = pool.getCandidates(1, ['invidious'])[0];
    if (!entry) throw new Error('no invidious');
    return runAdapter(entry, videoId);
  },
  piped: async (videoId) => {
    const entry = pool.getCandidates(1, ['piped'])[0];
    if (!entry) throw new Error('no piped');
    return runAdapter(entry, videoId);
  },
  sia: (videoId) => fetchSiaMeta(videoId),
  rapid: (videoId) => fetchRapid(videoId),
  dl360: async (videoId) => {
    const url = await resolve360(videoId);
    return normalizeVideo({ stream_url: url, highstreamUrl: url, videoId, provider: 'dl360' });
  },
  aijimy: (videoId) => fetchAijimy(videoId),
  companion: (videoId) => fetchInvCompanion(videoId)
};

function shuffleArray(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function getEduScratchParams() {
  const cached = eduCache.get('scratch');
  if (cached) return cached;
  const configJson = await fetchJson('https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json', {}, 4000);
  const params = configJson.params || '';
  eduCache.set('scratch', params);
  return params;
}

async function getEduKahootParams() {
  const cached = eduCache.get('kahoot');
  if (cached) return cached;
  const params = (await fetchText('https://raw.githubusercontent.com/wista-api-project/auto/refs/heads/main/edu/1.txt', {}, 4000)).trim();
  eduCache.set('kahoot', params);
  return params;
}

async function searchInvidiousChannel(name) {
  const instances = pool.getCandidates(5, ['invidious']);
  const bases = instances.length
    ? instances.map((e) => e.base)
    : ['https://yt.chocolatemoo53.com', 'https://invidious.f5.si', 'https://inv.nadeko.net'];
  const racers = bases.map((base) => fetchJson(
    `${base}/api/v1/search?q=${encodeURIComponent(name)}&type=channel`,
    {},
    3500
  ));
  return firstFulfilled(racers);
}

module.exports = {
  isValidId,
  parseCount,
  normalizeVideo,
  getVideoData,
  getComments,
  searchVideos,
  resolve360,
  fetchRapid,
  fetchSiaMeta,
  fetchAijimy,
  fetchInvCompanion,
  fetchNocookieFallback,
  getEduScratchParams,
  getEduKahootParams,
  searchInvidiousChannel,
  apiHandlers,
  shuffleArray,
  videoCache,
  streamUrlCache,
  searchCache,
  keys,
  RAPID_API_HOST,
  randomUA
};
