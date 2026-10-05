// YouTube Data API v3 — tìm kiếm, tra video, bộ nhớ đệm. API key chỉ sống ở máy chủ.
const API = 'https://www.googleapis.com/youtube/v3';
const SEARCH_TTL_MS = 6 * 3600_000;
const VIDEO_TTL_MS = 24 * 3600_000;
const ID_RE = /^[\w-]{11}$/;

export class YtError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function parseVideoId(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1] ?? null;
  }
  return id && ID_RE.test(id) ? id : null;
}

// Chỉ nhận link trang playlist (youtube.com/playlist?list=...), không nhận danh sách tự sinh 'RD...'.
export function parsePlaylistId(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m)\./, '');
  if ((host !== 'youtube.com' && host !== 'music.youtube.com') || u.pathname !== '/playlist') return null;
  const id = u.searchParams.get('list');
  return id && /^[\w-]{10,64}$/.test(id) && !id.startsWith('RD') ? id : null;
}

export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso ?? ''));
  if (!m) return null;
  const [d, h, mi, s] = m.slice(1).map(x => Number(x ?? 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

const normalizeQuery = q => String(q).trim().toLowerCase().replace(/\s+/g, ' ');

export function createYouTube({ apiKey, fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const searchCache = new Map();
  const videoCache = new Map();
  const fresh = (entry, ttl) => entry && now() - entry.at < ttl;
  // Hạn mức YouTube tính theo ngày giờ Thái Bình Dương (reset 14–15h chiều giờ VN). Chỉ đếm từ lúc máy chủ chạy.
  const COST = { search: 100 };
  const usage = { day: '', units: 0, quotaHit: false };
  const ptDay = () => new Date(now()).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const count = p => {
    const d = ptDay();
    if (usage.day !== d) Object.assign(usage, { day: d, units: 0, quotaHit: false });
    usage.units += COST[p] ?? 1;
  };

  async function call(path, params) {
    if (!apiKey) throw new YtError('no_key');
    const url = `${API}/${path}?${new URLSearchParams({ ...params, key: apiKey })}`;
    count(path);
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetchFn(url);
      } catch {
        if (attempt < 2) continue;
        throw new YtError('network');
      }
      if (res.ok) return res.json();
      const body = await res.json().catch(() => ({}));
      const reason = body?.error?.errors?.[0]?.reason;
      if (res.status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) {
        usage.quotaHit = true;
        throw new YtError('quota');
      }
      if (res.status >= 500 && attempt < 2) continue;
      throw new YtError('network');
    }
  }

  function toInfo(item) {
    const sn = item.snippet ?? {};
    return {
      videoId: item.id,
      title: sn.title ?? '',
      channel: sn.channelTitle ?? '',
      thumb: sn.thumbnails?.medium?.url ?? sn.thumbnails?.default?.url ?? '',
      durationSec: parseDuration(item.contentDetails?.duration) ?? 0,
      embeddable: item.status?.embeddable !== false,
    };
  }

  async function getVideos(ids) {
    const missing = ids.filter(id => !fresh(videoCache.get(id), VIDEO_TTL_MS));
    if (missing.length) {
      const data = await call('videos', { part: 'snippet,contentDetails,status', id: missing.join(',') });
      for (const item of data.items ?? []) videoCache.set(item.id, { at: now(), value: toInfo(item) });
    }
    return ids
      .map(id => videoCache.get(id))
      .filter(entry => fresh(entry, VIDEO_TTL_MS))
      .map(entry => entry.value);
  }

  async function getVideo(id) {
    if (!apiKey) throw new YtError('no_key');
    if (!ID_RE.test(String(id))) return null;
    const [v] = await getVideos([id]);
    return v ?? null;
  }

  async function search(q) {
    const key = normalizeQuery(q);
    const hit = searchCache.get(key);
    if (fresh(hit, SEARCH_TTL_MS)) return hit.value;
    const data = await call('search', {
      part: 'id', type: 'video', videoEmbeddable: 'true', maxResults: '10', regionCode: 'VN', q: key,
    });
    const ids = (data.items ?? []).map(i => i.id?.videoId).filter(Boolean);
    const videos = ids.length ? await getVideos(ids) : [];
    const value = videos.filter(v => v.embeddable && v.durationSec > 0);
    searchCache.set(key, { at: now(), value });
    return value;
  }

  async function getPlaylist(listId) {
    const data = await call('playlistItems', { part: 'contentDetails', playlistId: listId, maxResults: '50' });
    const ids = (data.items ?? []).map(i => i.contentDetails?.videoId).filter(Boolean);
    const videos = ids.length ? await getVideos(ids) : [];
    return videos.filter(v => v.embeddable && v.durationSec > 0);
  }

  return { search, getVideo, getPlaylist, usage: () => (ptDay() === usage.day ? { ...usage } : { day: ptDay(), units: 0, quotaHit: false }) };
}
