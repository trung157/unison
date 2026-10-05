// Chống dò mã: mỗi địa chỉ IP sai quá `maxFails` lần trong `windowMs` thì bị khoá thử `lockMs`.
// Thuần, không I/O — `now` truyền từ ngoài vào để dễ test.
export function createGuard({ maxFails = 5, windowMs = 10 * 60_000, lockMs = 15 * 60_000, now = Date.now } = {}) {
  const seen = new Map(); // key -> { fails: [thời điểm], lockedUntil }

  function entry(key) {
    let e = seen.get(key);
    if (!e) { e = { fails: [], lockedUntil: 0 }; seen.set(key, e); }
    return e;
  }

  return {
    // Còn bị khoá bao lâu (ms); 0 = được thử.
    lockedFor(key) {
      const e = seen.get(key);
      return e ? Math.max(0, e.lockedUntil - now()) : 0;
    },
    fail(key) {
      const t = now();
      const e = entry(key);
      e.fails = e.fails.filter(x => t - x < windowMs);
      e.fails.push(t);
      if (e.fails.length >= maxFails) { e.lockedUntil = t + lockMs; e.fails = []; }
    },
    ok(key) { seen.delete(key); },
    // Dọn mục cũ để Map không phình mãi.
    sweep() {
      const t = now();
      for (const [k, e] of seen) if (e.lockedUntil <= t && !e.fails.some(x => t - x < windowMs)) seen.delete(k);
    },
  };
}

// IP của người gửi. Chỉ tin header của proxy khi được cấu hình rõ (TRUST_PROXY), vì header này giả được.
export function clientIp({ headers = {}, address = '' }, trustProxy = '') {
  if (trustProxy === 'cloudflare' && headers['cf-connecting-ip']) return String(headers['cf-connecting-ip']);
  if (trustProxy === 'proxy' && headers['x-forwarded-for']) return String(headers['x-forwarded-for']).split(',')[0].trim();
  return String(address).replace(/^::ffff:/, '');
}
