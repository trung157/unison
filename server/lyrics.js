// Lời bài hát từ LRCLIB (kho cộng đồng, miễn phí) — chỉ dùng trong phòng nội bộ có mã.
const API = 'https://lrclib.net/api/search';
const TTL_MS = 24 * 3600_000;
const UA = 'unison/1.0 (self-hosted listen-together room)';

// Bỏ phần thừa trong tên video YouTube: (Official MV), [Lyrics], | Sơn Tùng M-TP, ft. ..., #hashtag
export function cleanTitle(title) {
  return String(title ?? '')
    .replace(/[([【][^)\]】]*[)\]】]/g, ' ')
    .split(/[|｜]/)[0]
    .replace(/\b(official|music video|mv|lyrics?|audio|video|m\/v|4k|hd)\b/gi, ' ')
    .replace(/#\S+/g, ' ')
    .replace(/\s+(ft\.?|feat\.?)\s.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createLyrics({ fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();

  async function get(track) {
    const key = track.videoId;
    const hit = cache.get(key);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    const q = cleanTitle(track.title);
    let value = null;
    if (q) {
      const res = await fetchFn(`${API}?${new URLSearchParams({ q })}`, { headers: { 'User-Agent': UA } });
      if (res.ok) {
        const list = (await res.json()) ?? [];
        const withText = list.filter(x => x.syncedLyrics || x.plainLyrics);
        // Ưu tiên bài có thời lượng khớp (±5 giây) và có lời chạy theo giây.
        const near = x => Math.abs((x.duration ?? 0) - track.durationSec) <= 5;
        const pick = withText.find(x => near(x) && x.syncedLyrics) ?? withText.find(near) ?? null;
        if (pick) value = { synced: pick.syncedLyrics ?? null, plain: pick.plainLyrics ?? null, source: 'LRCLIB' };
      }
    }
    cache.set(key, { at: now(), value });
    return value;
  }

  return { get };
}
