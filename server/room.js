// Logic phòng nhạc — thuần, không I/O. Mọi thời điểm `now` là ms giờ máy chủ, truyền từ ngoài vào.
export const DEFAULTS = { maxDurationMin: 15, maxPerUser: 5, autoResumeMin: 30 };
const END_GRACE_MS = 2000;
const HISTORY_MAX = 50;
const CHAT_MAX = 100;
const STATS_WEEKS = 8;
const AUTO_USER = { userId: 'auto', name: 'Tự phát' };
export const CHAT_REACTS = ['❤️', '😂', '👍', '😮', '🎉'];
const PLAYLIST_MAX = 30;
const PLAYLIST_TRACKS = 100;
const SCHEDULE_MAX = 20;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Một bài trong playlist chỉ giữ những gì cần để thêm lại vào hàng chờ.
const slim = t => ({
  videoId: t.videoId, source: t.source ?? 'yt', src: t.src ?? null, title: t.title,
  channel: t.channel ?? '', thumb: t.thumb ?? '', durationSec: t.durationSec,
});
const ymd = ms => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
// Số ngày làm (T2–T7) liền nhau có vào phòng, tính tới hôm nay (hôm nay chưa vào thì tính tới hôm qua).
function streak(days, now) {
  const set = new Set(days);
  const d = new Date(now);
  if (!set.has(ymd(d.getTime()))) d.setDate(d.getDate() - 1);
  let n = 0;
  for (let i = 0; i < 40; i++) {
    if (d.getDay() !== 0) {
      if (!set.has(ymd(d.getTime()))) break;
      n += 1;
    }
    d.setDate(d.getDate() - 1);
  }
  return n;
}
const hm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const DEFAULT_QUIET = {
  enabled: true,
  days: [1, 2, 3, 4, 5, 6], // 0 = Chủ nhật
  ranges: [['08:00', '12:00'], ['13:00', '17:30']], // khung giờ ĐƯỢC phát
};
const isTrack = t => t && typeof t.id === 'string' && typeof t.videoId === 'string'
  && Number.isFinite(t.durationSec) && t.addedBy && typeof t.addedBy.userId === 'string';

// Mã tuần ISO theo giờ máy chủ, ví dụ "2026-W41".
export function weekKey(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  const wk = 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(wk).padStart(2, '0')}`;
}

export class Room {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.random = cfg.random ?? Math.random;
    this.current = null;          // track + { startedAt, paused }
    this.queue = [];              // track + { votes: Set<userId> }
    this.skipVotes = new Set();
    this.errorVotes = new Set();  // người báo video đang phát bị lỗi
    this.listeners = new Map();   // userId -> { name, sockets }
    this.seq = 0;
    this.history = [];            // bài đã phát, mới nhất trước
    this.chat = [];               // tin nhắn, cũ nhất trước
    this.stats = {};              // weekKey -> { people: {name: {plays, likes}}, tracks: {videoId: {title, plays, likes}} }
    this.locked = false;          // chủ phòng khoá: chỉ chủ phòng thêm được bài
    this.autoFill = true;         // hàng chờ trống thì tự phát từ lịch sử
    this.quiet = structuredClone(DEFAULT_QUIET);
    this.theme = '';              // chủ đề chủ phòng đặt, hiện trên đầu trang
    this.playlists = [];          // { id, name, by, byId, tracks: [slim] }
    this.schedules = [];          // { id, time 'HH:MM', days, label, kind 'video'|'playlist', ref, info?, lastFired }
    this.fillPlaylistId = '';     // tự phát khi trống: '' = từ lịch sử, còn lại = id playlist
    this.birthdays = new Map();   // userId -> { name, md: 'MM-DD' } — chỉ ngày/tháng
    this.birthdaySong = null;     // bài chủ phòng chọn để phát khi chúc sinh nhật
    this.birthdayDone = {};       // userId -> 'YYYY-M-D' đã chúc
    this.attendance = {};         // userId -> { name, days: ['YYYY-M-D', ...] } — 30 ngày gần nhất
    this.blocks = new Map();      // userId -> { name, until } — chủ phòng chặn tạm
    this.poll = null;             // { id, question, options: [{ text, votes: Set }], by, open } — không lưu xuống đĩa
  }

  join(userId, name, now = Date.now(), avatar = '') {
    const a = (this.attendance[userId] ??= { name, days: [] });
    a.name = name;
    const today = ymd(now);
    if (a.days.at(-1) !== today) { a.days.push(today); if (a.days.length > 30) a.days.shift(); }
    const l = this.listeners.get(userId);
    if (l) { l.name = name; l.avatar = avatar; l.sockets += 1; }
    else this.listeners.set(userId, { name, avatar, sockets: 1 });
    if (!this.current) this.#fill(now);
  }

  leave(userId, now) {
    const l = this.listeners.get(userId);
    if (!l) return;
    l.sockets -= 1;
    if (l.sockets > 0) return;
    this.listeners.delete(userId);
    this.skipVotes.delete(userId);
    this.errorVotes.delete(userId);
    this.#checkSkip(now);
  }

  get skipNeeded() {
    return Math.floor(this.listeners.size / 2) + 1;
  }

  // user = { userId, name, admin? }
  addTrack(info, user, now, note = '', { bulk = false } = {}) {
    const { maxDurationMin, maxPerUser } = this.cfg;
    if (this.locked && !user.admin) return { ok: false, error: 'locked' };
    if (!info.embeddable) return { ok: false, error: 'not_embeddable' };
    if (!(info.durationSec > 0)) return { ok: false, error: 'live' };
    if (info.durationSec > maxDurationMin * 60) return { ok: false, error: 'too_long' };
    if (this.current?.videoId === info.videoId || this.queue.some(t => t.videoId === info.videoId)) {
      return { ok: false, error: 'duplicate' };
    }
    if (!user.admin && !bulk && this.queue.filter(t => t.addedBy.userId === user.userId).length >= maxPerUser) {
      return { ok: false, error: 'too_many' };
    }
    const track = this.#makeTrack(info, user, now, note);
    // Bài tự phát đang chạy thì nhường ngay cho bài người thật chọn.
    if (this.current && this.current.addedBy.userId !== AUTO_USER.userId) {
      this.queue.push({ ...track, votes: new Set() });
    } else {
      this.#play(track, now);
    }
    return { ok: true, track };
  }

  // Xếp lượt xen kẽ: vòng 1 gồm bài đầu của mỗi người, vòng 2 bài thứ hai... Trong cùng vòng xếp theo 👍 rồi giờ thêm.
  // Người có bài đang phát thì bài kế của họ lùi sang vòng sau.
  sortedQueue() {
    const byVotes = [...this.queue].sort((a, b) =>
      b.votes.size - a.votes.size || a.addedAt - b.addedAt || a.n - b.n);
    const used = new Map();
    const cur = this.current?.addedBy.userId;
    if (cur && cur !== AUTO_USER.userId) used.set(cur, 1);
    const round = new Map();
    for (const t of byVotes) {
      const u = t.addedBy.userId;
      const k = used.get(u) ?? 0;
      round.set(t, k);
      used.set(u, k + 1);
    }
    return byVotes.sort((a, b) => round.get(a) - round.get(b));
  }

  vote(trackId, userId) {
    const t = this.queue.find(x => x.id === trackId);
    if (!t) return { ok: false, error: 'not_found' };
    if (t.votes.has(userId)) t.votes.delete(userId);
    else t.votes.add(userId);
    return { ok: true };
  }

  remove(trackId, userId, admin = false) {
    const i = this.queue.findIndex(x => x.id === trackId);
    if (i < 0) return { ok: false, error: 'not_found' };
    if (!admin && this.queue[i].addedBy.userId !== userId) return { ok: false, error: 'not_owner' };
    this.queue.splice(i, 1);
    return { ok: true };
  }

  skip(userId, now) {
    if (!this.current) return { ok: false, error: 'nothing_playing' };
    if (!this.listeners.has(userId)) return { ok: false, error: 'not_listener' };
    if (this.skipVotes.has(userId)) this.skipVotes.delete(userId);
    else this.skipVotes.add(userId);
    this.#checkSkip(now);
    return { ok: true };
  }

  // Chủ phòng chuyển bài ngay, không cần bỏ phiếu.
  forceSkip(now) {
    if (!this.current) return { ok: false, error: 'nothing_playing' };
    this.advance(now);
    return { ok: true };
  }

  // Chỉ chuyển bài khi quá nửa người nghe cùng báo lỗi — một máy lỗi riêng không phá cả phòng.
  videoError(videoId, userId, now) {
    if (this.current?.videoId !== videoId) return { ok: false, error: 'stale' };
    if (!this.listeners.has(userId)) return { ok: false, error: 'not_listener' };
    this.errorVotes.add(userId);
    this.#checkSkip(now);
    return { ok: true };
  }

  advance(now) {
    const [next] = this.sortedQueue();
    if (!next) {
      this.current = null;
      this.skipVotes.clear();
      this.errorVotes.clear();
      this.#fill(now);
      return;
    }
    this.queue = this.queue.filter(t => t !== next);
    const { votes, ...track } = next;
    this.#play(track, now, votes.size);
  }

  positionSec(now) {
    const c = this.current;
    if (!c) return 0;
    if (c.paused) return c.paused.atSec;
    return Math.max(0, (now - c.startedAt) / 1000);
  }

  pause(byName, now) {
    const c = this.current;
    if (!c) return { ok: false, error: 'nothing_playing' };
    if (c.paused) return { ok: true };
    c.paused = { atSec: Math.min(this.positionSec(now), c.durationSec), byName, since: now };
    return { ok: true };
  }

  resume(now) {
    const c = this.current;
    if (!c) return { ok: false, error: 'nothing_playing' };
    if (!c.paused) return { ok: true };
    c.startedAt = now - c.paused.atSec * 1000;
    c.paused = null;
    return { ok: true };
  }

  nextDeadline() {
    const c = this.current;
    if (!c) return null;
    if (c.paused) return c.paused.since + this.cfg.autoResumeMin * 60_000;
    return c.startedAt + c.durationSec * 1000 + END_GRACE_MS;
  }

  tick(now) {
    const d = this.nextDeadline();
    if (d === null || now < d) return false;
    if (this.current.paused) this.resume(now);
    else this.advance(now);
    return true;
  }

  // ---------- chủ phòng ----------
  setLocked(v) { this.locked = !!v; return { ok: true }; }
  setAutoFill(v, now) {
    this.autoFill = !!v;
    if (this.autoFill && !this.current) this.#fill(now);
    return { ok: true };
  }
  setQuiet(q) {
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!q || !Array.isArray(q.days) || !Array.isArray(q.ranges)) return { ok: false, error: 'bad_quiet' };
    const days = [...new Set(q.days.map(Number))].filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    const ranges = q.ranges.filter(r => Array.isArray(r) && time.test(r[0]) && time.test(r[1]) && r[0] < r[1]);
    if (ranges.length !== q.ranges.length || !ranges.length) return { ok: false, error: 'bad_quiet' };
    this.quiet = { enabled: !!q.enabled, days, ranges: ranges.map(r => [r[0], r[1]]) };
    return { ok: true };
  }

  // Chủ phòng phát ngay một bài (dùng khi chúc mừng) — bài đang phát bị thay, hàng chờ giữ nguyên.
  playNow(info, user, now, note = '') {
    if (!info.embeddable) return { ok: false, error: 'not_embeddable' };
    if (!(info.durationSec > 0)) return { ok: false, error: 'live' };
    this.queue = this.queue.filter(t => t.videoId !== info.videoId);
    const track = this.#makeTrack(info, user, now, note);
    this.#play(track, now);
    return { ok: true, track };
  }

  setTheme(text) {
    this.theme = typeof text === 'string' ? text.trim().slice(0, 80) : '';
    return { ok: true };
  }

  // Thống kê của một người (theo tên): tuần này + cộng dồn các tuần còn giữ.
  myStats(name, now) {
    const week = weekKey(now);
    const zero = { plays: 0, likes: 0 };
    const all = { ...zero };
    for (const s of Object.values(this.stats)) {
      const p = s.people[name];
      if (p) { all.plays += p.plays; all.likes += p.likes; }
    }
    const ranked = this.leaderboard(now).people;
    const i = ranked.findIndex(p => p.name === name);
    const w = this.stats[week]?.people[name];
    return { week: { plays: w?.plays ?? 0, likes: w?.likes ?? 0 }, all, rank: i < 0 ? null : i + 1 };
  }

  // ---------- chat ----------
  addChat(name, text, now, avatar = '') {
    const clean = typeof text === 'string' ? text.trim().slice(0, 300) : '';
    if (!clean) return { ok: false, error: 'empty' };
    const msg = { id: `m${++this.seq}`, name, avatar, text: clean, at: now, reacts: {} };
    this.chat.push(msg);
    if (this.chat.length > CHAT_MAX) this.chat.splice(0, this.chat.length - CHAT_MAX);
    return { ok: true, msg };
  }

  // Thả/bỏ cảm xúc vào một tin chat (theo tên người).
  reactChat(msgId, name, emoji) {
    if (!CHAT_REACTS.includes(emoji)) return { ok: false, error: 'server' };
    const m = this.chat.find(x => x.id === msgId);
    if (!m) return { ok: false, error: 'not_found' };
    const list = ((m.reacts ??= {})[emoji] ??= []);
    const i = list.indexOf(name);
    if (i >= 0) list.splice(i, 1); else list.push(name);
    if (!list.length) delete m.reacts[emoji];
    return { ok: true };
  }

  // ---------- playlist chung ----------
  savePlaylist(name, tracks, user) {
    const clean = typeof name === 'string' ? name.trim().slice(0, 60) : '';
    if (!clean) return { ok: false, error: 'bad_playlist' };
    const list = tracks.filter(t => t && t.videoId && t.durationSec > 0).slice(0, PLAYLIST_TRACKS).map(slim);
    if (!list.length) return { ok: false, error: 'empty_playlist' };
    const same = this.playlists.find(p => p.name.toLowerCase() === clean.toLowerCase());
    if (same) {
      if (same.byId !== user.userId && !user.admin) return { ok: false, error: 'playlist_taken' };
      same.tracks = list;
      return { ok: true, playlist: same };
    }
    if (this.playlists.length >= PLAYLIST_MAX) return { ok: false, error: 'playlist_full' };
    const p = { id: `p${++this.seq}`, name: clean, by: user.name, byId: user.userId, tracks: list };
    this.playlists.push(p);
    return { ok: true, playlist: p };
  }

  // Lưu hàng chờ hiện tại (kèm bài đang phát) thành playlist.
  saveQueueAsPlaylist(name, user) {
    const tracks = [this.current, ...this.sortedQueue()].filter(t => t && t.addedBy?.userId !== AUTO_USER.userId);
    return this.savePlaylist(name, tracks, user);
  }

  addToPlaylist(id, info) {
    const p = this.playlists.find(x => x.id === id);
    if (!p) return { ok: false, error: 'not_found' };
    if (p.tracks.some(t => t.videoId === info.videoId)) return { ok: false, error: 'in_playlist' };
    if (p.tracks.length >= PLAYLIST_TRACKS) return { ok: false, error: 'playlist_long' };
    p.tracks.push(slim(info));
    return { ok: true };
  }

  deletePlaylist(id, user) {
    const i = this.playlists.findIndex(x => x.id === id);
    if (i < 0) return { ok: false, error: 'not_found' };
    if (this.playlists[i].byId !== user.userId && !user.admin) return { ok: false, error: 'not_owner' };
    this.playlists.splice(i, 1);
    this.schedules = this.schedules.filter(s => !(s.kind === 'playlist' && s.ref === id));
    return { ok: true };
  }

  // Nạp cả playlist vào hàng chờ; bài trùng/khoá thì bỏ qua. Trả số bài đã thêm.
  enqueuePlaylist(id, user, now) {
    const p = this.playlists.find(x => x.id === id);
    if (!p) return { ok: false, error: 'not_found' };
    if (this.locked && !user.admin) return { ok: false, error: 'locked' };
    let added = 0;
    for (const t of p.tracks) {
      if (this.addTrack({ ...t, embeddable: true }, user, now, '', { bulk: true }).ok) added += 1;
    }
    return { ok: true, added };
  }

  // ---------- hẹn giờ phát (chủ phòng) ----------
  addSchedule({ time, days, label, kind, ref, info }) {
    if (!TIME_RE.test(time ?? '')) return { ok: false, error: 'bad_schedule' };
    const ds = [...new Set((Array.isArray(days) ? days : []).map(Number))].filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!ds.length) return { ok: false, error: 'bad_schedule' };
    if (kind === 'playlist' && !this.playlists.some(p => p.id === ref)) return { ok: false, error: 'not_found' };
    if (kind === 'video' && !(info?.durationSec > 0)) return { ok: false, error: 'not_found' };
    if (kind !== 'playlist' && kind !== 'video') return { ok: false, error: 'bad_schedule' };
    if (this.schedules.length >= SCHEDULE_MAX) return { ok: false, error: 'bad_schedule' };
    const s = {
      id: `s${++this.seq}`, time, days: ds, label: typeof label === 'string' ? label.trim().slice(0, 60) : '',
      kind, ref: kind === 'playlist' ? ref : info.videoId, info: kind === 'video' ? slim(info) : null, lastFired: '',
    };
    this.schedules.push(s);
    this.schedules.sort((a, b) => a.time.localeCompare(b.time));
    return { ok: true };
  }

  removeSchedule(id) {
    const n = this.schedules.length;
    this.schedules = this.schedules.filter(s => s.id !== id);
    return n === this.schedules.length ? { ok: false, error: 'not_found' } : { ok: true };
  }

  // Lịch tới giờ (trong 2 phút sau mốc, chưa chạy hôm nay) — đánh dấu đã chạy rồi trả về.
  dueSchedules(now) {
    const day = new Date(now).getDay();
    const today = ymd(now);
    const due = [];
    for (const s of this.schedules) {
      if (s.lastFired === today || !s.days.includes(day)) continue;
      const [h, m] = s.time.split(':').map(Number);
      const at = new Date(now); at.setHours(h, m, 0, 0);
      if (now >= at.getTime() && now - at.getTime() < 120_000) { s.lastFired = today; due.push(s); }
    }
    return due;
  }

  // Chạy một lịch: bài → phát ngay; playlist → bài đầu phát ngay, phần còn lại vào hàng chờ.
  runSchedule(s, now) {
    const who = { userId: `lich-${s.id}`, name: s.label ? `⏰ ${s.label}` : `⏰ Hẹn ${s.time}`, admin: true };
    const tracks = s.kind === 'video' ? [s.info] : (this.playlists.find(p => p.id === s.ref)?.tracks ?? []);
    if (!tracks.length) return { ok: false, error: 'not_found' };
    const [first, ...rest] = tracks;
    const r = this.playNow({ ...first, embeddable: true }, who, now, s.label);
    if (!r.ok) return r;
    for (const t of rest) this.addTrack({ ...t, embeddable: true }, who, now, '', { bulk: true });
    return { ok: true };
  }

  // ---------- tự phát theo playlist ----------
  setFillPlaylist(id, now) {
    if (id && !this.playlists.some(p => p.id === id)) return { ok: false, error: 'not_found' };
    this.fillPlaylistId = id || '';
    if (!this.current) this.#fill(now);
    return { ok: true };
  }

  // ---------- sinh nhật ----------
  setBirthday(userId, name, md) {
    if (md === '' || md == null) { this.birthdays.delete(userId); return { ok: true }; }
    const m = /^(\d{2})-(\d{2})$/.exec(md);
    const mm = m && Number(m[1]), dd = m && Number(m[2]);
    const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1];
    if (!m || !maxDay || dd < 1 || dd > maxDay) return { ok: false, error: 'bad_birthday' };
    this.birthdays.set(userId, { name, md });
    return { ok: true };
  }
  setBirthdaySong(info) { this.birthdaySong = info ? slim(info) : null; return { ok: true }; }
  birthdaysToday(now) {
    const d = new Date(now);
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return [...this.birthdays].filter(([, b]) => b.md === md).map(([id, b]) => ({ id, name: b.name }));
  }
  // Người có sinh nhật hôm nay mà chưa chúc → đánh dấu đã chúc, trả danh sách tên.
  dueBirthdays(now) {
    const today = ymd(now);
    const due = this.birthdaysToday(now).filter(b => this.birthdayDone[b.id] !== today);
    for (const b of due) this.birthdayDone[b.id] = today;
    return due.map(b => b.name);
  }

  // ---------- huy hiệu ----------
  // Tính theo tên (bảng tuần lưu theo tên) + theo userId (điểm danh).
  badges(now) {
    const out = {};
    const add = (name, e, t) => { (out[name] ??= []).push({ e, t }); };
    const week = this.stats[weekKey(now)];
    const top = this.leaderboard(now).people[0];
    if (top && top.likes > 0) add(top.name, '🏆', 'DJ của tuần — nhiều 👍 nhất tuần này');
    for (const [name, p] of Object.entries(week?.people ?? {})) {
      if ((p.fresh ?? 0) >= 5) add(name, '🧭', `Người khai phá — ${p.fresh} bài lần đầu vào phòng tuần này`);
      if (p.likes >= 20) add(name, '❤️', `Được yêu thích — ${p.likes} 👍 tuần này`);
    }
    for (const a of Object.values(this.attendance)) {
      const s = streak(a.days, now);
      if (s >= 5) add(a.name, '🔥', `Chăm chỉ — vào phòng ${s} ngày làm liền`);
    }
    for (const b of this.birthdaysToday(now)) add(b.name, '🎂', 'Hôm nay sinh nhật!');
    return out;
  }

  // ---------- chủ phòng: chặn tạm, xoá tin ----------
  block(userId, minutes, now) {
    const l = this.listeners.get(userId);
    const m = Number(minutes);
    if (!l || !(m > 0) || m > 24 * 60) return { ok: false, error: 'not_found' };
    this.blocks.set(userId, { name: l.name, until: now + m * 60_000 });
    this.skipVotes.delete(userId);
    this.queue = this.queue.filter(t => t.addedBy.userId !== userId);
    return { ok: true };
  }
  unblock(userId) { this.blocks.delete(userId); return { ok: true }; }
  blockedUntil(userId, now) {
    const b = this.blocks.get(userId);
    if (!b) return 0;
    if (b.until <= now) { this.blocks.delete(userId); return 0; }
    return b.until;
  }
  deleteChat(msgId) {
    const n = this.chat.length;
    this.chat = this.chat.filter(m => m.id !== msgId);
    return n === this.chat.length ? { ok: false, error: 'not_found' } : { ok: true };
  }

  // ---------- bình chọn (chủ phòng mở) ----------
  startPoll(question, options, by) {
    const q = typeof question === 'string' ? question.trim().slice(0, 100) : '';
    const opts = (Array.isArray(options) ? options : []).map(o => String(o).trim().slice(0, 40)).filter(Boolean);
    const uniq = [...new Set(opts)];
    if (!q || uniq.length < 2 || uniq.length > 6) return { ok: false, error: 'bad_poll' };
    this.poll = { id: `v${++this.seq}`, question: q, options: uniq.map(text => ({ text, votes: new Set() })), by, open: true };
    return { ok: true };
  }

  votePoll(index, userId) {
    const p = this.poll;
    if (!p || !p.open) return { ok: false, error: 'no_poll' };
    const opt = p.options[index];
    if (!opt) return { ok: false, error: 'no_poll' };
    const had = opt.votes.has(userId);
    for (const o of p.options) o.votes.delete(userId);
    if (!had) opt.votes.add(userId);
    return { ok: true };
  }

  endPoll(remove = false) {
    if (!this.poll) return { ok: false, error: 'no_poll' };
    if (remove || !this.poll.open) this.poll = null;
    else this.poll.open = false;
    return { ok: true };
  }

  // ---------- tổng kết tuần ----------
  weekSummary(now) {
    const week = weekKey(now);
    const s = this.stats[week] ?? { people: {}, tracks: {} };
    const lb = this.leaderboard(now);
    const plays = Object.values(s.people).reduce((n, p) => n + p.plays, 0);
    const likes = Object.values(s.people).reduce((n, p) => n + p.likes, 0);
    return {
      week, plays, likes, sec: s.sec ?? 0, people: Object.keys(s.people).length,
      topTrack: lb.tracks[0] ?? null, topPerson: lb.people[0] ?? null,
      mostPlayed: Object.values(s.tracks).sort((a, b) => b.plays - a.plays)[0] ?? null,
    };
  }

  // ---------- bảng xếp hạng tuần ----------
  leaderboard(now) {
    const week = weekKey(now);
    const s = this.stats[week] ?? { people: {}, tracks: {} };
    const rank = obj => Object.entries(obj)
      .map(([k, v]) => ({ key: k, ...v }))
      .sort((a, b) => b.likes - a.likes || b.plays - a.plays)
      .slice(0, 10);
    return {
      week,
      people: rank(s.people).map(({ key, plays, likes }) => ({ name: key, plays, likes })),
      tracks: rank(s.tracks).map(({ title, plays, likes }) => ({ title, plays, likes })),
    };
  }

  toJSON() {
    return {
      v: 1,
      seq: this.seq,
      current: this.current,
      queue: this.queue.map(t => ({ ...t, votes: [...t.votes] })),
      history: this.history,
      chat: this.chat,
      stats: this.stats,
      locked: this.locked,
      autoFill: this.autoFill,
      quiet: this.quiet,
      theme: this.theme,
      playlists: this.playlists,
      schedules: this.schedules,
      blocks: [...this.blocks],
      fillPlaylistId: this.fillPlaylistId,
      birthdays: [...this.birthdays],
      birthdaySong: this.birthdaySong,
      birthdayDone: this.birthdayDone,
      attendance: this.attendance,
    };
  }

  static fromJSON(data, cfg, now) {
    if (!data || data.v !== 1 || !Number.isInteger(data.seq) || !Array.isArray(data.queue)
      || !data.queue.every(isTrack) || (data.current != null && !isTrack(data.current))) {
      throw new Error('state.json sai định dạng');
    }
    const room = new Room(cfg);
    room.seq = data.seq;
    room.queue = data.queue.map(t => ({ ...t, votes: new Set(t.votes ?? []) }));
    room.current = data.current ?? null;
    if (Array.isArray(data.history)) room.history = data.history.slice(0, HISTORY_MAX);
    if (Array.isArray(data.chat)) room.chat = data.chat.slice(-CHAT_MAX);
    if (data.stats && typeof data.stats === 'object') room.stats = data.stats;
    room.locked = !!data.locked;
    room.autoFill = data.autoFill ?? true;
    if (data.quiet) room.setQuiet(data.quiet);
    room.setTheme(data.theme ?? '');
    if (Array.isArray(data.playlists)) room.playlists = data.playlists.slice(0, PLAYLIST_MAX);
    if (Array.isArray(data.schedules)) room.schedules = data.schedules.slice(0, SCHEDULE_MAX);
    room.fillPlaylistId = typeof data.fillPlaylistId === 'string' ? data.fillPlaylistId : '';
    if (Array.isArray(data.birthdays)) room.birthdays = new Map(data.birthdays);
    room.birthdaySong = data.birthdaySong ?? null;
    if (data.birthdayDone && typeof data.birthdayDone === 'object') room.birthdayDone = data.birthdayDone;
    if (data.attendance && typeof data.attendance === 'object') room.attendance = data.attendance;
    if (Array.isArray(data.blocks)) room.blocks = new Map(data.blocks.filter(b => b[1]?.until > now));
    if (room.current?.paused) room.current.paused.since = now;
    room.tick(now);
    return room;
  }

  viewFor(userId, { admin = false } = {}) {
    const c = this.current;
    const pub = t => ({
      id: t.id, videoId: t.videoId, source: t.source ?? 'yt', src: t.src ?? null,
      title: t.title, channel: t.channel, thumb: t.thumb, durationSec: t.durationSec, addedBy: t.addedBy.name,
      note: t.note ?? '',
    });
    return {
      current: c && {
        ...pub(c), auto: c.addedBy.userId === AUTO_USER.userId, startedAt: c.startedAt,
        paused: c.paused && { atSec: c.paused.atSec, byName: c.paused.byName, since: c.paused.since },
      },
      queue: this.sortedQueue().map(t => ({
        ...pub(t), mine: t.addedBy.userId === userId, votes: t.votes.size, votedByMe: t.votes.has(userId),
      })),
      skip: { count: this.skipVotes.size, needed: this.skipNeeded, votedByMe: this.skipVotes.has(userId) },
      listeners: [...this.listeners].map(([id, l]) => ({
        name: l.name, avatar: l.avatar ?? '', ...(admin ? { id, blockedUntil: this.blocks.get(id)?.until ?? 0 } : {}),
      })),
      blockedUntil: this.blocks.get(userId)?.until ?? 0,
      fillPlaylistId: this.fillPlaylistId,
      maxDurationSec: this.cfg.maxDurationMin * 60,
      badges: this.badges(Date.now()),
      birthdaysToday: this.birthdaysToday(Date.now()).map(b => b.name),
      myBirthday: this.birthdays.get(userId)?.md ?? '',
      birthdaySong: admin ? (this.birthdaySong?.title ?? '') : '',
      blocked: admin ? [...this.blocks].map(([id, b]) => ({ id, name: b.name, until: b.until })) : [],
      history: this.history.map(h => ({
        videoId: h.videoId, source: h.source ?? 'yt', title: h.title, channel: h.channel, thumb: h.thumb,
        durationSec: h.durationSec, addedBy: h.addedBy, note: h.note ?? '', playedAt: h.playedAt,
      })),
      chat: this.chat.slice(-50),
      locked: this.locked,
      autoFill: this.autoFill,
      quiet: this.quiet,
      theme: this.theme,
      playlists: this.playlists.map(p => ({
        id: p.id, name: p.name, by: p.by, mine: p.byId === userId, count: p.tracks.length,
        sec: p.tracks.reduce((n, t) => n + t.durationSec, 0), titles: p.tracks.slice(0, 5).map(t => t.title),
      })),
      schedules: admin ? this.schedules.map(s => ({
        id: s.id, time: s.time, days: s.days, label: s.label, kind: s.kind,
        what: s.kind === 'video' ? s.info.title : (this.playlists.find(p => p.id === s.ref)?.name ?? '?'),
      })) : [],
      poll: this.poll && {
        id: this.poll.id, question: this.poll.question, by: this.poll.by, open: this.poll.open,
        options: this.poll.options.map(o => ({ text: o.text, count: o.votes.size })),
        myVote: this.poll.options.findIndex(o => o.votes.has(userId)),
      },
      isAdmin: admin,
    };
  }

  #makeTrack(info, user, now, note = '') {
    const n = ++this.seq;
    return {
      id: `t${n}`, n, videoId: info.videoId, source: info.source ?? 'yt', src: info.src ?? null,
      title: info.title, channel: info.channel, thumb: info.thumb, durationSec: info.durationSec,
      addedBy: { userId: user.userId, name: user.name }, addedAt: now,
      note: typeof note === 'string' ? note.trim().slice(0, 100) : '',
    };
  }

  #play(track, now, likes = 0) {
    this.current = { ...track, startedAt: now, paused: null };
    this.skipVotes.clear();
    this.errorVotes.clear();
    this.#record(track, now, likes);
  }

  // Ghi lịch sử + thống kê tuần (bài tự phát không tính điểm cho ai).
  #record(track, now, likes) {
    const prevLikes = this.history.find(h => h.videoId === track.videoId)?.likes ?? 0;
    const isNew = !this.history.some(h => h.videoId === track.videoId)
      && !Object.values(this.stats).some(s => s.tracks?.[track.videoId]);
    this.history = this.history.filter(h => h.videoId !== track.videoId);
    this.history.unshift({
      videoId: track.videoId, source: track.source ?? 'yt', src: track.src ?? null, title: track.title,
      channel: track.channel, thumb: track.thumb, durationSec: track.durationSec,
      addedBy: track.addedBy.name, note: track.note ?? '', likes: likes + prevLikes, playedAt: now,
    });
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
    const week = weekKey(now);
    const s = (this.stats[week] ??= { people: {}, tracks: {} });
    s.sec = (s.sec ?? 0) + track.durationSec;
    if (track.addedBy.userId === AUTO_USER.userId || track.addedBy.userId.startsWith('lich-')) return; // tự phát, hẹn giờ: không tính điểm
    const p = (s.people[track.addedBy.name] ??= { plays: 0, likes: 0 });
    p.plays += 1; p.likes += likes;
    if (isNew) p.fresh = (p.fresh ?? 0) + 1;
    const t = (s.tracks[track.videoId] ??= { title: track.title, plays: 0, likes: 0 });
    t.plays += 1; t.likes += likes;
    const weeks = Object.keys(this.stats).sort();
    for (const w of weeks.slice(0, Math.max(0, weeks.length - STATS_WEEKS))) delete this.stats[w];
  }

  // Hàng chờ trống + có người nghe + bật tự phát → chọn ngẫu nhiên từ lịch sử (bài nhiều 👍 dễ trúng hơn),
  // tránh 10 bài vừa phát.
  #fill(now) {
    if (!this.autoFill || this.current || this.listeners.size === 0) return;
    const recent = new Set(this.history.slice(0, 10).map(h => h.videoId));
    const pl = this.fillPlaylistId && this.playlists.find(p => p.id === this.fillPlaylistId);
    if (pl?.tracks?.length) {
      // Từ playlist: ngẫu nhiên đều, tránh bài vừa phát (playlist ngắn thì chỉ tránh bài cuối).
      let cand = pl.tracks.filter(t => !recent.has(t.videoId));
      if (!cand.length) cand = pl.tracks.filter(t => t.videoId !== this.history[0]?.videoId);
      if (!cand.length) cand = pl.tracks;
      const pick = cand[Math.floor(this.random() * cand.length)];
      this.#play(this.#makeTrack({ ...pick, embeddable: true }, AUTO_USER, now), now);
      return;
    }
    let pool = this.history.filter(h => !recent.has(h.videoId));
    if (!pool.length) pool = this.history.slice(1);
    if (!pool.length) return;
    const total = pool.reduce((s, h) => s + 1 + (h.likes ?? 0), 0);
    let r = this.random() * total;
    const pick = pool.find(h => (r -= 1 + (h.likes ?? 0)) < 0) ?? pool[pool.length - 1];
    const track = this.#makeTrack({ ...pick, embeddable: true }, AUTO_USER, now);
    this.#play(track, now);
  }

  #checkSkip(now) {
    if (!this.current) return;
    const need = this.skipNeeded;
    if ((this.skipVotes.size > 0 && this.skipVotes.size >= need) || (this.errorVotes.size > 0 && this.errorVotes.size >= need)) {
      this.advance(now);
    }
  }
}
