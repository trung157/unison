// Nối Socket.IO ↔ Room ↔ YouTube ↔ kho mp3 ↔ store. Không chứa luật phòng — luật nằm trong room.js.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { parseVideoId, parsePlaylistId } from './youtube.js';
import { isOpen, QUIET_NAME } from './quiet.js';
import { CHAT_REACTS } from './room.js';
import { createGuard, clientIp } from './guard.js';

// Việc bị cấm khi đang bị chủ phòng chặn tạm.
const BLOCKABLE = new Set(['addTrack', 'chat', 'react', 'chatReact', 'playlistLoad', 'playlistSaveQueue', 'playlistAddCurrent', 'skip', 'pause', 'resume']);
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, looksLikeMp3 } from './library.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SEARCH_GAP_MS = 3000;
const CHAT_GAP_MS = 1000;
const REACT_GAP_MS = 700;
const QUIET_CHECK_MS = 20_000;
const USER_ID_RE = /^[\w-]{8,64}$/;
const REACTIONS = ['❤️', '🔥', '😂', '👏', '🎉', '😴'];
export const AVATARS = ['🐱', '🐶', '🐼', '🦊', '🐸', '🐯', '🐵', '🦄', '🐧', '🐙', '🌻', '🍀', '⭐', '🎧', '🎸', '☕'];

export function messages(cfg) {
  return {
    not_embeddable: 'Video này không cho phát ngoài YouTube',
    live: 'Không thêm được video đang phát trực tiếp',
    too_long: `Bài dài quá ${cfg.maxDurationMin} phút`,
    duplicate: 'Bài này đang phát hoặc đã có trong hàng chờ',
    too_many: `Mỗi người chỉ được ${cfg.maxPerUser} bài đang chờ`,
    locked: 'Chủ phòng đang khoá thêm bài',
    not_found: 'Không tìm thấy bài',
    not_owner: 'Chỉ người thêm bài mới xoá được',
    nothing_playing: 'Chưa có bài nào đang phát',
    not_listener: 'Bấm "Vào nghe" trước đã',
    not_joined: 'Bấm "Vào nghe" trước đã',
    not_admin: 'Chỉ chủ phòng làm được việc này',
    bad_admin: 'Mã chủ phòng không đúng',
    quiet: 'Đang giờ yên lặng — chưa phát tiếp được',
    bad_quiet: 'Giờ yên lặng không hợp lệ',
    stale: 'Bài đã chuyển rồi',
    empty: 'Tin nhắn trống',
    bad_name: 'Tên không hợp lệ (1–24 ký tự)',
    bad_query: 'Gõ tên bài hoặc dán link YouTube',
    too_fast: 'Chậm lại chút nhé',
    no_key: 'Máy chủ chưa có YouTube API key — báo quản trị viên',
    quota: 'Hôm nay hết lượt tìm kiếm, anh/chị dán link YouTube vào nhé',
    network: 'Không kết nối được, thử lại sau',
    bad_file: 'Chỉ nhận file .mp3',
    file_too_big: 'File lớn quá 20 MB',
    library_full: 'Kho nhạc đã đầy (5 GB) — báo quản trị viên dọn bớt',
    bad_duration: 'Không đọc được thời lượng file',
    bad_playlist: 'Đặt tên cho playlist nhé',
    empty_playlist: 'Hàng chờ đang trống, chưa có gì để lưu',
    playlist_taken: 'Tên này đã có người dùng — đặt tên khác nhé',
    playlist_full: 'Đã đủ 30 playlist — xoá bớt cái cũ',
    playlist_long: 'Playlist đã đủ 100 bài',
    in_playlist: 'Bài này đã có trong playlist',
    bad_schedule: 'Giờ hẹn không hợp lệ',
    bad_poll: 'Cần câu hỏi và 2–6 lựa chọn',
    no_poll: 'Bình chọn đã kết thúc',
    bad_birthday: 'Ngày sinh không hợp lệ (ngày/tháng)',
    too_many_tries: 'Thử sai nhiều lần quá — đợi 15 phút rồi thử lại',
    blocked: 'Chủ phòng đang tạm chặn bạn thêm bài / chat — thử lại sau',
    server: 'Lỗi máy chủ, thử lại sau',
  };
}

export function createApp({
  room, yt, store, library = null, lyrics = null, roomCode = '', adminCode = '', appName = 'Unison',
  now = Date.now, log = console, backup = null, trustProxy = '', guard = createGuard({ now }),
}) {
  const startedAt = now();
  const app = express();
  // no-cache: Cloudflare và trình duyệt luôn hỏi lại, để giao diện mới tới tay mọi người ngay sau khi sửa.
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });
  // Trang có tên app: chèn APP_NAME (thoát ký tự HTML) trước khi gửi.
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const named = (file, type) => (req, res) => {
    const text = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    res.type(type).set('Cache-Control', 'no-cache').send(text.split('{{APP_NAME}}').join(type === 'json' ? JSON.stringify(appName).slice(1, -1) : esc(appName)));
  };
  app.get(['/', '/index.html'], named('index.html', 'html'));
  app.get('/huong-dan.html', named('huong-dan.html', 'html'));
  app.get('/manifest.webmanifest', named('manifest.webmanifest', 'json'));
  app.use(express.static(PUBLIC_DIR, { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
  app.get('/healthz', (req, res) => res.json({ ok: true, uptimeSec: Math.round((now() - startedAt) / 1000) }));
  app.get('/vendor/qrcode.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, '..', 'node_modules', 'qrcode-generator', 'dist', 'qrcode.js')));
  app.get('/vendor/NoSleep.min.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, '..', 'node_modules', 'nosleep.js', 'dist', 'NoSleep.min.js')));
  if (library) app.use('/files', express.static(library.filesDir, { maxAge: '7d', fallthrough: false }));
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 1e6 });
  const MSG = messages(room.cfg);
  const last = new Map(); // `${việc}:${userId}` -> thời điểm, để chống bấm liên tục
  let timer = null;
  let quietTimer = null;
  let closed = false;

  const fail = code => ({ ok: false, error: MSG[code] ?? MSG.server });
  const tooFast = (kind, userId, gap) => {
    const k = `${kind}:${userId}`;
    const t = now();
    if (t - (last.get(k) ?? 0) < gap) return true;
    last.set(k, t);
    return false;
  };
  const isQuietNow = () => !isOpen(new Date(now()), room.quiet);

  function broadcast() {
    for (const s of io.of('/').sockets.values()) {
      s.emit('state', room.viewFor(s.data.userId ?? null, { admin: !!s.data.admin }));
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (closed) return;
    const deadline = room.nextDeadline();
    if (deadline === null) return;
    timer = setTimeout(() => {
      if (room.tick(now())) {
        enforceQuiet();
        changed();
      } else schedule();
    }, Math.max(0, deadline - now()) + 50);
  }

  function changed() {
    store.save(room.toJSON());
    broadcast();
    schedule();
  }

  // Ngoài giờ cho phép thì dừng cả phòng; vào giờ thì tự phát tiếp bài đã bị giờ yên lặng dừng.
  function enforceQuiet() {
    const c = room.current;
    if (!c) return false;
    if (isQuietNow()) {
      if (c.paused) return false;
      room.pause(QUIET_NAME, now());
      return true;
    }
    if (c.paused?.byName === QUIET_NAME) {
      room.resume(now());
      return true;
    }
    return false;
  }
  // Mỗi 20 giây: giờ yên lặng + lịch hẹn phát.
  function runDue() {
    const due = room.dueSchedules(now());
    for (const s of due) {
      const r = room.runSchedule(s, now());
      if (r.ok) io.emit('scheduled', { label: s.label || `Hẹn ${s.time}` });
      else log.error('[unison] lịch hẹn không chạy được:', s.id, r.error);
    }
    return due.length > 0 || runBirthdays();
  }
  function runBirthdays() {
    if (isQuietNow()) return false;
    const names = room.dueBirthdays(now());
    if (!names.length) return false;
    const text = `Chúc mừng sinh nhật ${names.join(', ')}! 🎂`;
    if (room.birthdaySong) room.playNow({ ...room.birthdaySong, embeddable: true }, { userId: 'lich-sinh-nhat', name: '🎂 Sinh nhật', admin: true }, now(), text);
    io.emit('celebrate', { text, by: appName });
    return true;
  }
  quietTimer = setInterval(() => { const a = runDue(); if (enforceQuiet() || a) changed(); }, QUIET_CHECK_MS);

  // Có mã phòng thì chỉ cho kết nối khi gửi đúng mã.
  // Mã phòng + mã chủ phòng: sai 5 lần / 10 phút thì khoá thử 15 phút theo IP.
  const codeOk = code => !roomCode || code === roomCode;
  const ipOfSocket = s => clientIp({ headers: s.handshake.headers, address: s.handshake.address }, trustProxy);
  const ipOfReq = r => clientIp({ headers: r.headers, address: r.socket.remoteAddress }, trustProxy);
  // Kiểm mã có chống dò: trả 'ok' | 'bad' | 'locked'.
  const tryCode = (kind, ip, good) => {
    const key = `${kind}:${ip}`;
    if (guard.lockedFor(key)) return 'locked';
    if (good) { guard.ok(key); return 'ok'; }
    guard.fail(key);
    return guard.lockedFor(key) ? 'locked' : 'bad';
  };
  const sweepTimer = setInterval(() => guard.sweep(), 10 * 60_000);
  sweepTimer.unref?.();
  io.use((socket, next) => {
    if (!roomCode) return next();
    const r = tryCode('room', ipOfSocket(socket), codeOk(socket.handshake.auth?.code));
    if (r === 'ok') return next();
    next(new Error(r === 'locked' ? 'too_many_tries' : 'bad_code'));
  });

  // Tải mp3: thân yêu cầu là nguyên tệp; mã phòng, người tải, tên bài, thời lượng nằm trong header.
  app.post('/api/upload', express.raw({ type: () => true, limit: MAX_FILE_BYTES + 1024 }), (req, res) => {
    const send = (code, extra = {}) => res.json(code ? fail(code) : { ok: true, ...extra });
    try {
      if (!library) return send('server');
      if (roomCode) {
        const r = tryCode('room', ipOfReq(req), codeOk(req.get('x-room-code') ?? ''));
        if (r !== 'ok') return res.status(r === 'locked' ? 429 : 403).json(fail(r === 'locked' ? 'too_many_tries' : 'not_joined'));
      }
      const userId = req.get('x-user-id') ?? '';
      const listener = room.listeners.get(userId);
      if (!listener) return send('not_joined');
      if (room.blockedUntil(userId, now())) return send('blocked');
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !looksLikeMp3(buf)) return send('bad_file');
      if (buf.length > MAX_FILE_BYTES) return send('file_too_big');
      if (library.totalBytes() + buf.length > MAX_TOTAL_BYTES) return send('library_full');
      const durationSec = Math.round(Number(req.get('x-duration')));
      if (!(durationSec > 0)) return send('bad_duration');
      let title = 'Bài tải lên';
      try { title = decodeURIComponent(req.get('x-title') ?? '').trim().slice(0, 120) || title; } catch { /* tên hỏng */ }
      const info = library.add({ buf, title, durationSec, uploadedBy: listener.name, now: now() });
      const r = room.addTrack(info, { userId, name: listener.name, admin: false }, now());
      if (!r.ok) return send(null, { added: false, reason: MSG[r.error] ?? MSG.server, info });
      enforceQuiet();
      changed();
      return send(null, { added: true, info });
    } catch (e) {
      log.error('[unison] lỗi tải mp3:', e);
      return send('server');
    }
  });
  app.use('/api/upload', (err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json(fail('file_too_big'));
    next(err);
  });

  async function findInfo(videoId) {
    if (typeof videoId !== 'string') return null;
    if (videoId.startsWith('file:')) return library?.get(videoId) ?? null;
    return yt.getVideo(videoId);
  }

  io.on('connection', socket => {
    const on = (event, handler, { needJoin = true, needAdmin = false } = {}) => {
      socket.on(event, async (payload, cb) => {
        const reply = typeof cb === 'function' ? cb : () => {};
        try {
          if (needJoin && !socket.data.userId) return reply(fail('not_joined'));
          if (needAdmin && !socket.data.admin) return reply(fail('not_admin'));
          if (BLOCKABLE.has(event) && !socket.data.admin && room.blockedUntil(socket.data.userId, now())) return reply(fail('blocked'));
          const p = payload && typeof payload === 'object' ? payload : {};
          reply((await handler(p)) ?? { ok: true });
        } catch (e) {
          if (!e?.code) log.error(`[unison] lỗi khi xử lý ${event}:`, e);
          reply(fail(e?.code ?? 'server'));
        }
      });
    };
    const simple = (event, fn, opts) => on(event, p => {
      const r = fn(p);
      if (!r.ok) return fail(r.error);
      enforceQuiet();
      changed();
      return { ok: true };
    }, opts);
    const me = () => ({ userId: socket.data.userId, name: socket.data.name, admin: !!socket.data.admin });

    socket.emit('state', room.viewFor(null));

    on('ping', ({ t0 }) => ({ ok: true, t0, serverNow: now() }), { needJoin: false });

    on('join', ({ userId, name, avatar }) => {
      const clean = typeof name === 'string' ? name.trim().slice(0, 24) : '';
      if (typeof userId !== 'string' || !USER_ID_RE.test(userId) || !clean) return fail('bad_name');
      if (socket.data.userId) room.leave(socket.data.userId, now());
      socket.data.userId = userId;
      socket.data.name = clean;
      socket.data.avatar = AVATARS.includes(avatar) ? avatar : '';
      room.join(userId, clean, now(), socket.data.avatar);
      enforceQuiet();
      changed();
      return { ok: true, name: clean };
    }, { needJoin: false });

    on('admin', ({ code }) => {
      if (!adminCode) return fail('bad_admin');
      const r = tryCode('admin', ipOfSocket(socket), typeof code === 'string' && code === adminCode);
      if (r !== 'ok') return fail(r === 'locked' ? 'too_many_tries' : 'bad_admin');
      socket.data.admin = true;
      broadcast();
      return { ok: true };
    });

    on('search', async ({ q }) => {
      if (typeof q !== 'string' || !q.trim() || q.length > 300) return fail('bad_query');
      const listId = parsePlaylistId(q);
      if (listId) return { ok: true, playlist: true, results: await yt.getPlaylist(listId) };
      const id = parseVideoId(q);
      if (id) {
        const v = await yt.getVideo(id);
        return { ok: true, results: v ? [v] : [] };
      }
      const local = library ? library.search(q) : [];
      if (tooFast('search', socket.data.userId, SEARCH_GAP_MS)) return fail('too_fast');
      let online = [];
      try { online = await yt.search(q); } catch (e) { if (!local.length) throw e; }
      return { ok: true, results: [...local, ...online] };
    });

    on('addTrack', async ({ videoId, note }) => {
      const info = await findInfo(videoId);
      if (!info) return fail('not_found');
      const r = room.addTrack(info, me(), now(), typeof note === 'string' ? note : '');
      if (!r.ok) return fail(r.error);
      enforceQuiet();
      changed();
      return { ok: true };
    });

    on('react', ({ emoji }) => {
      if (!REACTIONS.includes(emoji)) return fail('server');
      if (tooFast('react', socket.data.userId, REACT_GAP_MS)) return { ok: true };
      io.emit('reaction', { emoji, name: socket.data.name });
      return { ok: true };
    });

    on('chat', ({ text }) => {
      if (tooFast('chat', socket.data.userId, CHAT_GAP_MS)) return fail('too_fast');
      const r = room.addChat(socket.data.name, text, now(), socket.data.avatar ?? '');
      if (!r.ok) return fail(r.error);
      changed();
      return { ok: true };
    });

    on('leaderboard', () => ({
      ok: true, ...room.leaderboard(now()), me: room.myStats(socket.data.name, now()), summary: room.weekSummary(now()),
    }));

    simple('chatReact', ({ msgId, emoji }) => (CHAT_REACTS.includes(emoji) ? room.reactChat(msgId, socket.data.name, emoji) : { ok: false, error: 'server' }));
    simple('playlistSaveQueue', ({ name }) => room.saveQueueAsPlaylist(name, me()));
    simple('playlistDelete', ({ id }) => room.deletePlaylist(id, me()));
    on('playlistAddCurrent', ({ id }) => {
      const c = room.current;
      if (!c) return fail('nothing_playing');
      const r = room.addToPlaylist(id, c);
      if (!r.ok) return fail(r.error);
      changed();
      return { ok: true };
    });
    on('playlistLoad', ({ id }) => {
      const r = room.enqueuePlaylist(id, me(), now());
      if (!r.ok) return fail(r.error);
      enforceQuiet();
      changed();
      return { ok: true, added: r.added };
    });
    on('adminSchedule', async ({ time, days, label, link, playlistId }) => {
      let r;
      if (playlistId) r = room.addSchedule({ time, days, label, kind: 'playlist', ref: playlistId });
      else {
        const info = typeof link === 'string' && link.trim() ? await findInfo(parseVideoId(link) ?? link.trim()) : null;
        if (!info) return fail('not_found');
        if (!info.embeddable) return fail('not_embeddable');
        r = room.addSchedule({ time, days, label, kind: 'video', info });
      }
      if (!r.ok) return fail(r.error);
      changed();
      return { ok: true };
    }, { needAdmin: true });
    simple('adminScheduleRemove', ({ id }) => room.removeSchedule(id), { needAdmin: true });
    simple('setBirthday', ({ md }) => room.setBirthday(socket.data.userId, socket.data.name, md));
    simple('adminFillPlaylist', ({ id }) => room.setFillPlaylist(id, now()), { needAdmin: true });
    on('adminBirthdaySong', async ({ link }) => {
      if (!link || !String(link).trim()) { room.setBirthdaySong(null); changed(); return { ok: true }; }
      const info = await findInfo(parseVideoId(link) ?? String(link).trim());
      if (!info) return fail('not_found');
      if (!info.embeddable) return fail('not_embeddable');
      room.setBirthdaySong(info);
      changed();
      return { ok: true, title: info.title };
    }, { needAdmin: true });
    simple('adminBlock', ({ userId, minutes }) => room.block(userId, minutes, now()), { needAdmin: true });
    simple('adminUnblock', ({ userId }) => room.unblock(userId), { needAdmin: true });
    simple('adminDeleteChat', ({ msgId }) => room.deleteChat(msgId), { needAdmin: true });
    on('adminStatus', () => {
      const sockets = io.of('/').sockets.size;
      const mem = process.memoryUsage();
      return {
        ok: true, startedAt, now: now(), sockets,
        listeners: [...room.listeners.values()].map(l => ({ name: l.name, tabs: l.sockets })),
        yt: yt.usage?.() ?? null,
        library: library ? { bytes: library.totalBytes(), max: MAX_TOTAL_BYTES, files: library.count() } : null,
        backup: backup?.status() ?? null,
        memMB: Math.round(mem.rss / 1048576),
        quietNow: isQuietNow(),
        counts: { history: room.history.length, chat: room.chat.length, playlists: room.playlists.length, schedules: room.schedules.length },
      };
    }, { needAdmin: true });
    simple('adminPoll', ({ question, options }) => room.startPoll(question, options, socket.data.name), { needAdmin: true });
    simple('adminPollEnd', ({ remove }) => room.endPoll(!!remove), { needAdmin: true });
    simple('pollVote', ({ index }) => room.votePoll(Number(index), socket.data.userId));

    on('lyrics', async () => {
      const c = room.current;
      if (!c || !lyrics || c.source === 'file') return { ok: true, lyrics: null };
      return { ok: true, trackId: c.id, lyrics: await lyrics.get(c) };
    });

    simple('vote', ({ trackId }) => room.vote(trackId, socket.data.userId));
    simple('remove', ({ trackId }) => room.remove(trackId, socket.data.userId, !!socket.data.admin));
    simple('skip', () => room.skip(socket.data.userId, now()));
    simple('pause', () => room.pause(socket.data.name, now()));
    simple('resume', () => (isQuietNow() && !socket.data.admin ? { ok: false, error: 'quiet' } : room.resume(now())));
    simple('videoError', ({ videoId }) => room.videoError(videoId, socket.data.userId, now()));

    simple('adminSkip', () => room.forceSkip(now()), { needAdmin: true });
    simple('adminLock', ({ value }) => room.setLocked(value), { needAdmin: true });
    simple('adminAutoFill', ({ value }) => room.setAutoFill(value, now()), { needAdmin: true });
    simple('adminQuiet', ({ quiet }) => room.setQuiet(quiet), { needAdmin: true });
    simple('adminTheme', ({ text }) => room.setTheme(text), { needAdmin: true });

    // Chúc mừng: dải chúc + pháo hoa trên mọi máy; có link bài thì phát ngay bài đó.
    on('adminCelebrate', async ({ text, link }) => {
      const msg = typeof text === 'string' ? text.trim().slice(0, 120) : '';
      if (!msg) return fail('empty');
      if (typeof link === 'string' && link.trim()) {
        const info = await findInfo(parseVideoId(link) ?? link.trim());
        if (!info) return fail('not_found');
        const r = room.playNow(info, me(), now(), msg);
        if (!r.ok) return fail(r.error);
        enforceQuiet();
        changed();
      }
      io.emit('celebrate', { text: msg, by: socket.data.name });
      return { ok: true };
    }, { needAdmin: true });

    socket.on('disconnect', () => {
      if (!socket.data.userId) return;
      room.leave(socket.data.userId, now());
      changed();
    });
  });

  enforceQuiet();
  schedule();

  return {
    httpServer,
    io,
    listen(port, host) {
      return new Promise(resolve => httpServer.listen(port, host, () => resolve(httpServer.address().port)));
    },
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(quietTimer);
      clearInterval(sweepTimer);
      store.flush();
      return new Promise(resolve => io.close(() => { clearTimeout(timer); store.flush(); resolve(); }));
    },
  };
}
