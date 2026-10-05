'use strict';
// Máy người nghe: nhận trạng thái phòng, canh trình phát (YouTube hoặc mp3) theo giờ máy chủ.
const $ = id => document.getElementById(id);
const APP_NAME = document.querySelector('meta[name=app-name]')?.content || 'Unison';
const SYNC_MS = 5000;
const MAX_DRIFT_SEC = 2;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const REACTIONS = ['❤️', '🔥', '😂', '👏', '🎉', '😴'];
const AVATARS = ['🐱', '🐶', '🐼', '🦊', '🐸', '🐯', '🐵', '🦄', '🐧', '🐙', '🌻', '🍀', '⭐', '🎧', '🎸', '☕'];
const DAY_NAMES = [[1, 'T2'], [2, 'T3'], [3, 'T4'], [4, 'T5'], [5, 'T6'], [6, 'T7'], [0, 'CN']];

const saved = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* chế độ riêng tư */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* chế độ riêng tư */ } },
};

let userId = saved.get('pn_user', '');
if (!/^[\w-]{8,64}$/.test(userId)) {
  userId = 'u' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  saved.set('pn_user', userId);
}

// Mã phòng gửi kèm mỗi lần kết nối (hàm được gọi lại khi nối lại, nên luôn lấy mã mới nhất).
{
  const ma = new URLSearchParams(location.search).get('ma');
  if (ma) { saved.set('pn_code', ma.trim()); history.replaceState(null, '', location.pathname); }
}
const socket = io({ auth: cb => cb({ code: saved.get('pn_code', '') }) });
const audio = $('audio');
let state = null;
let joined = false;
let myName = '';
let offset = 0;
const samples = [];
let player = null;
let playerReady = false;
let ytTrackId = null;     // bài YouTube đang nạp trong trình phát
let audioTrackId = null;  // bài mp3 đang nạp trong thẻ audio
let needTapSince = null;
let volume = Number(saved.get('pn_vol', 80));
let muted = saved.get('pn_mute', '0') === '1';
let activeTab = 'queue';
// Tin chat đã xem tới đâu — lưu trên máy để tải lại trang không hiện lại số tin cũ.
// Máy mới vào lần đầu: coi như đã xem hết tin cũ.
let seenChat = Number(saved.get('pn_seen_chat', -1));
function markSeen(at) {
  if (!(at > seenChat)) return;
  seenChat = at;
  saved.set('pn_seen_chat', String(at));
}
let lyricsFor = null;
let lyricLines = [];
let quietDirty = false;
let avatar = saved.get('pn_avatar', '');
let announcedId = null;

// ---------- tiện ích ----------
const serverNow = () => Date.now() + offset;
const fmt = s => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// Màu tên riêng cho mỗi người, sinh cố định từ tên.
function nameColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 70% 68%)`;
}
function who(name, av) {
  const s = el('span', { className: 'who', textContent: `${av ? av + ' ' : ''}${name}` });
  s.style.color = nameColor(name);
  const bs = state?.badges?.[name];
  if (!bs?.length) return s;
  return el('span', { className: 'who-wrap' }, s, el('span', { className: 'badges', textContent: bs.map(b => b.e).join(''), title: bs.map(b => `${b.e} ${b.t}`).join('\n') }));
}
const hhmm = ms => new Date(ms - offset).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}
const send = (ev, payload) => new Promise(resolve =>
  socket.timeout(15_000).emit(ev, payload ?? {}, (err, res) =>
    resolve(err ? { ok: false, error: 'Máy chủ không phản hồi' } : res)));
async function act(ev, payload) {
  const r = await send(ev, payload);
  if (!r.ok) toast(r.error);
  return r;
}
function targetSec() {
  const c = state?.current;
  if (!c) return 0;
  if (c.paused) return c.paused.atSec;
  return Math.max(0, (serverNow() - c.startedAt) / 1000);
}

// ---------- đồng hồ ----------
async function measureClock() {
  const t0 = Date.now();
  const r = await send('ping', { t0 });
  const t1 = Date.now();
  if (!r.ok) return;
  samples.push({ rtt: t1 - t0, off: r.serverNow - (t0 + t1) / 2 });
  if (samples.length > 5) samples.shift();
  offset = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
}
async function burstClock() {
  for (let i = 0; i < 5; i++) {
    await measureClock();
    await new Promise(r => setTimeout(r, 200));
  }
  syncPlayer();
}
setInterval(measureClock, 60_000);

// ---------- socket ----------
socket.on('connect', async () => {
  $('offline').hidden = true;
  burstClock();
  if (!joined) return;
  const r = await send('join', { userId, name: myName, avatar });
  if (!r.ok) {
    joined = false;
    $('join').hidden = false;
    toast(r.error);
    return;
  }
  const adminCode = saved.get('pn_admin', '');
  if (adminCode && !(await send('admin', { code: adminCode })).ok) saved.del('pn_admin');
});
socket.on('disconnect', () => { $('offline').hidden = false; });
// Sai/thiếu mã phòng: máy chủ từ chối kết nối — hiện ô nhập mã, không tự thử lại.
socket.on('connect_error', err => {
  if (err.message === 'too_many_tries') {
    $('offline').hidden = true;
    $('code-row').hidden = false;
    $('join').hidden = false;
    toast('Thử sai mã nhiều lần quá — đợi 15 phút rồi thử lại');
    return;
  }
  if (err.message !== 'bad_code') return;
  $('offline').hidden = true;
  $('code-row').hidden = false;
  $('join').hidden = false;
  if (saved.get('pn_code', '')) toast('Mã phòng không đúng');
});
socket.on('state', s => {
  state = s;
  render();
  syncPlayer();
});
socket.on('reaction', ({ emoji, name }) => floatReaction(emoji, name));
socket.on('celebrate', ({ text, by }) => celebrate(text, by));
socket.on('scheduled', ({ label }) => toast(`⏰ Tới giờ: ${label}`));

// ---------- vào phòng ----------
$('name').value = saved.get('pn_name', '');
function renderAvatars() {
  $('avatars').replaceChildren(...AVATARS.map(a => {
    const b = el('button', { type: 'button', textContent: a, className: a === avatar ? 'active' : '' });
    b.onclick = () => { avatar = a === avatar ? '' : a; renderAvatars(); };
    return b;
  }));
}
renderAvatars();
// Đã từng vào trên máy này thì tự vào lại bằng tên cũ (lệnh join gửi trong sự kiện connect).
myName = $('name').value.trim();
if (myName) {
  joined = true;
  $('join').hidden = true;
}
$('btn-rename').addEventListener('click', () => {
  $('join').hidden = false;
  $('name').focus();
});
$('join-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('name').value.trim();
  if (!name) return;
  if (!$('code-row').hidden) {
    saved.set('pn_code', $('code').value.trim());
    socket.connect();
  }
  const wasJoined = joined;
  joined = true;
  myName = name;
  $('join').hidden = true;
  kickPlay(); // gọi ngay trong cú bấm để trình duyệt cho phát tiếng
  saved.set('pn_avatar', avatar);
  const r = await send('join', { userId, name, avatar });
  if (!r.ok) {
    joined = wasJoined;
    $('join').hidden = false;
    toast(r.error);
    return;
  }
  myName = r.name;
  saved.set('pn_name', myName);
  $('code-row').hidden = true;
});
// Trình duyệt chỉ cho phát tiếng sau cú chạm đầu tiên — chạm đâu cũng bật nhạc.
document.addEventListener('pointerdown', () => kickPlay(true));

// ---------- chủ phòng ----------
$('btn-admin').addEventListener('click', async () => {
  if (state?.isAdmin) return toast('Anh/chị đang là chủ phòng');
  const code = prompt('Mã chủ phòng:');
  if (!code) return;
  const r = await act('admin', { code: code.trim() });
  if (r.ok) { saved.set('pn_admin', code.trim()); toast('Đã vào quyền chủ phòng'); }
});
$('btn-force-skip').addEventListener('click', () => act('adminSkip'));
$('btn-lock').addEventListener('click', () => act('adminLock', { value: !state?.locked }));
$('btn-autofill').addEventListener('click', () => act('adminAutoFill', { value: !state?.autoFill }));
$('quiet-days').append(...DAY_NAMES.map(([d, label]) =>
  el('label', {}, el('input', { type: 'checkbox', value: String(d) }), ` ${label}`)));
$('quiet-form').addEventListener('input', () => { quietDirty = true; });
$('theme-form').addEventListener('submit', async e => {
  e.preventDefault();
  const r = await act('adminTheme', { text: $('theme-text').value });
  if (r.ok) toast($('theme-text').value.trim() ? 'Đã đặt chủ đề' : 'Đã xoá chủ đề');
});
$('celebrate-form').addEventListener('submit', async e => {
  e.preventDefault();
  const r = await act('adminCelebrate', { text: $('celebrate-text').value, link: $('celebrate-link').value });
  if (r.ok) { $('celebrate-text').value = ''; $('celebrate-link').value = ''; }
});
$('quiet-form').addEventListener('submit', async e => {
  e.preventDefault();
  const ranges = $('quiet-ranges').value.split(',').map(s => s.trim()).filter(Boolean)
    .map(s => s.split('-').map(x => x.trim().padStart(5, '0')));
  const days = [...$('quiet-days').querySelectorAll('input:checked')].map(i => Number(i.value));
  const r = await act('adminQuiet', { quiet: { enabled: $('quiet-on').checked, days, ranges } });
  if (r.ok) { quietDirty = false; toast('Đã lưu giờ yên lặng'); }
});
function fillQuietForm(q) {
  if (quietDirty) return;
  $('quiet-on').checked = q.enabled;
  for (const i of $('quiet-days').querySelectorAll('input')) i.checked = q.days.includes(Number(i.value));
  $('quiet-ranges').value = q.ranges.map(r => r.join('-')).join(', ');
}
function quietText(q) {
  if (!q?.enabled) return '';
  const days = DAY_NAMES.filter(([d]) => q.days.includes(d)).map(([, l]) => l).join(', ');
  return `🕘 Giờ phát: ${days} · ${q.ranges.map(r => r.join('–')).join(', ')}`;
}

// ---------- phím nhạc trên bàn phím / tai nghe (máy tính) ----------
// YouTube nhúng tự nhận phím ⏯ của máy và chỉ dừng trên máy này. Trình phát tự dừng/chạy trái với phòng
// mà không phải do mình ra lệnh → coi là người dùng bấm phím nhạc, áp cho cả phòng.
// Điện thoại bỏ qua: tắt màn hình cũng làm YouTube dừng, không được dừng cả phòng vì thế.
const isDesktop = !matchMedia('(pointer: coarse)').matches;
let ownCmdAt = 0;
function mediaKeyFromYT(st) {
  const c = state?.current;
  if (!isDesktop || !joined || !c || c.source === 'file' || ytTrackId !== c.id) return;
  if (Date.now() - ownCmdAt < 3000) return;
  if (st === YT.PlayerState.PAUSED && !c.paused && targetSec() < c.durationSec - 3) act('pause');
  else if (st === YT.PlayerState.PLAYING && c.paused) act('resume');
}

// ---------- trình phát ----------
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player('player', {
    width: '100%',
    height: '100%',
    playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, fs: 0, iv_load_policy: 3 },
    events: {
      onReady: () => { playerReady = true; applyVolume(); syncPlayer(); },
      onStateChange: e => { applyVolume(); mediaKeyFromYT(e.data); },
      onError: e => {
        const c = state?.current;
        if ([100, 101, 150].includes(e.data) && c && c.id === ytTrackId) {
          socket.emit('videoError', { videoId: c.videoId });
        }
      },
    },
  });
};
audio.addEventListener('error', () => {
  const c = state?.current;
  if (c?.source === 'file' && c.id === audioTrackId) socket.emit('videoError', { videoId: c.videoId });
});
audio.addEventListener('loadedmetadata', () => {
  const c = state?.current;
  if (c?.source === 'file' && c.id === audioTrackId) audio.currentTime = targetSec();
});

function showTap(show) {
  $('tap-play').hidden = !show;
  if (!show) needTapSince = null;
}
function waitTap() {
  needTapSince ??= Date.now();
  if (Date.now() - needTapSince > 3000) $('tap-play').hidden = false;
}

function playAudio() {
  audio.play().then(() => showTap(false)).catch(() => { $('tap-play').hidden = false; });
}
function stopYT() {
  if (playerReady && ytTrackId) { player.stopVideo(); ytTrackId = null; }
}
function stopAudio() {
  if (audioTrackId) { audio.pause(); audio.removeAttribute('src'); audio.load(); audioTrackId = null; }
}

function syncAudio(c) {
  const target = targetSec();
  if (audioTrackId !== c.id) {
    audioTrackId = c.id;
    audio.src = c.src;
    audio.currentTime = c.paused ? c.paused.atSec : target;
    setMediaSession(c);
    if (!c.paused) playAudio();
    return;
  }
  if (c.paused) {
    showTap(false);
    if (!audio.paused) audio.pause();
    if (Math.abs(audio.currentTime - c.paused.atSec) > MAX_DRIFT_SEC) audio.currentTime = c.paused.atSec;
    return;
  }
  if (target >= c.durationSec - 1) return;
  if (audio.paused) {
    audio.currentTime = target;
    playAudio();
    return;
  }
  if (Math.abs(audio.currentTime - target) > MAX_DRIFT_SEC) audio.currentTime = target;
}

function syncYT(c) {
  if (!playerReady) return;
  const S = YT.PlayerState;
  const target = targetSec();
  if (c.id !== ytTrackId) {
    ytTrackId = c.id;
    ownCmdAt = Date.now();
    if (c.paused) player.cueVideoById(c.videoId, c.paused.atSec);
    else player.loadVideoById(c.videoId, target);
    return;
  }
  const st = player.getPlayerState();
  const drift = Math.abs(player.getCurrentTime() - target);
  if (c.paused) {
    showTap(false);
    if (st === S.PLAYING || st === S.BUFFERING) { ownCmdAt = Date.now(); player.pauseVideo(); }
    if (drift > MAX_DRIFT_SEC) player.seekTo(c.paused.atSec, true);
    return;
  }
  if (target >= c.durationSec - 1) return; // sắp hết bài, chờ máy chủ chuyển
  if (st === S.PLAYING) {
    showTap(false);
    if (drift > MAX_DRIFT_SEC) player.seekTo(target, true);
    return;
  }
  if (st === S.BUFFERING) return;
  ownCmdAt = Date.now();
  player.seekTo(target, true);
  player.playVideo();
  waitTap();
}

function syncPlayer() {
  if (!joined) return;
  const c = state?.current;
  if (!c) {
    stopYT();
    stopAudio();
    showTap(false);
    return;
  }
  if (c.source === 'file') { stopYT(); syncAudio(c); }
  else { stopAudio(); syncYT(c); }
}
setInterval(syncPlayer, SYNC_MS);

// Gọi trong cú chạm của người dùng: trình duyệt cho phát tiếng.
function kickPlay(onlyIfStopped = false) {
  const c = state?.current;
  if (!joined || !c || c.paused) return syncPlayer();
  if (c.source === 'file') {
    if (onlyIfStopped && !audio.paused) return;
    if (audioTrackId !== c.id) return syncPlayer();
    audio.currentTime = targetSec();
    playAudio();
  } else {
    if (!playerReady) return;
    if (onlyIfStopped && player.getPlayerState() === YT.PlayerState.PLAYING) return;
    if (ytTrackId !== c.id) return syncPlayer();
    ownCmdAt = Date.now();
    player.seekTo(targetSec(), true);
    player.playVideo();
    applyVolume();
  }
}
$('tap-play').addEventListener('click', () => { kickPlay(); showTap(false); });

// Nút điều khiển trên màn hình khoá (chỉ có với bài mp3 — YouTube nhúng không phát nền).
function setMediaSession(c) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: c.title, artist: c.channel, album: APP_NAME,
    artwork: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
  navigator.mediaSession.setActionHandler('play', () => (state?.current?.paused ? act('resume') : kickPlay()));
  navigator.mediaSession.setActionHandler('pause', () => act('pause'));
  navigator.mediaSession.setActionHandler('nexttrack', () => act('skip'));
}

// ---------- âm lượng (riêng máy này) ----------
function applyVolume() {
  $('btn-mute').textContent = muted ? '🔇' : '🔊';
  audio.volume = volume / 100;
  audio.muted = muted;
  if (!playerReady) return;
  player.setVolume(volume);
  if (muted) player.mute();
  else player.unMute();
}
$('volume').value = volume;
$('volume').addEventListener('input', e => {
  volume = Number(e.target.value);
  saved.set('pn_vol', volume);
  if (muted && volume > 0) { muted = false; saved.set('pn_mute', '0'); }
  applyVolume();
});
$('btn-mute').addEventListener('click', () => {
  muted = !muted;
  saved.set('pn_mute', muted ? '1' : '0');
  applyVolume();
});
applyVolume();

// ---------- nút chung ----------
$('btn-pause').addEventListener('click', () => act(state?.current?.paused ? 'resume' : 'pause'));
$('btn-skip').addEventListener('click', () => act('skip'));

// ---------- phím tắt ----------
const KEYS_HELP = 'Phím cách: tạm dừng / phát tiếp · M: tắt/bật tiếng · L: thả ❤️ · N: bỏ qua · Ctrl/⌘ + K: tìm bài · Esc: thoát ô gõ';
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('q').focus();
    $('q').select();
    return;
  }
  const t = e.target;
  if (e.key === 'Escape' && t.matches?.('input, textarea')) { t.blur(); return; }
  if (!joined || e.ctrlKey || e.metaKey || e.altKey || t.matches?.('input, textarea, select, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (k === ' ' && !t.matches('button')) { e.preventDefault(); $('btn-pause').click(); }
  else if (k === 'm') $('btn-mute').click();
  else if (k === 'l') send('react', { emoji: '❤️' });
  else if (k === 'n') $('btn-skip').click();
});
$('btn-keys').addEventListener('click', () => toast(KEYS_HELP));

// ---------- thả cảm xúc ----------
$('reactions').append(...REACTIONS.map(emoji => {
  const b = el('button', { type: 'button', textContent: emoji, title: 'Thả cảm xúc cho cả phòng' });
  b.onclick = () => send('react', { emoji });
  return b;
}));
function floatReaction(emoji, name) {
  const node = el('div', { className: 'float' }, el('span', { textContent: emoji }), el('small', { textContent: name }));
  node.style.left = `${10 + Math.random() * 80}%`;
  $('fx').append(node);
  setTimeout(() => node.remove(), 2600);
}

// ---------- chúc mừng + lời tặng ----------
function celebrate(text, by) {
  const box = $('celebrate');
  box.replaceChildren(el('div', { className: 'big', textContent: `🎉 ${text}` }), el('div', { className: 'muted small', textContent: `— ${by}` }));
  box.hidden = false;
  for (let i = 0; i < 24; i++) setTimeout(() => floatReaction(['🎉', '🎊', '🎂', '✨', '🥳'][i % 5], ''), i * 120);
  clearTimeout(celebrate.timer);
  celebrate.timer = setTimeout(() => { box.hidden = true; }, 8000);
}
function announceNote(c) {
  if (!c || c.id === announcedId) return;
  announcedId = c.id;
  if (!c.note || c.auto) return;
  const box = $('celebrate');
  box.replaceChildren(el('div', { className: 'big', textContent: `💌 ${c.addedBy} tặng` }), el('div', { textContent: c.note }),
    el('div', { className: 'muted small', textContent: c.title }));
  box.hidden = false;
  clearTimeout(celebrate.timer);
  celebrate.timer = setTimeout(() => { box.hidden = true; }, 6000);
}
$('celebrate').addEventListener('click', () => { $('celebrate').hidden = true; });

// ---------- màn hình tối ----------
// Phủ đen kín màn hình + giữ máy không tự khoá (Wake Lock trên HTTPS, video câm lặp lại trên HTTP).
// Bấm nút nguồn thì vẫn là tắt thật — trình duyệt sẽ dừng trình phát YouTube (bài mp3 thì vẫn chạy).
const noSleep = typeof NoSleep === 'function' ? new NoSleep() : null;
let dimTimer = null;
let lastDimTap = 0;
function updateDim() {
  $('dim-clock').textContent = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  $('dim-title').textContent = state?.current ? state.current.title : 'Phòng đang im lặng';
}
async function enterDim() {
  try { await noSleep?.enable(); } catch { toast('Máy này không giữ được màn hình sáng — màn hình có thể tự tắt'); }
  $('dim').hidden = false;
  updateDim();
  dimTimer = setInterval(updateDim, 15_000);
  document.documentElement.requestFullscreen?.().catch(() => {});
}
function exitDim() {
  $('dim').hidden = true;
  clearInterval(dimTimer);
  noSleep?.disable();
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
$('btn-dim').addEventListener('click', enterDim);
$('dim').addEventListener('pointerup', () => {
  const t = Date.now();
  if (t - lastDimTap < 400) exitDim();
  lastDimTap = t;
});

// ---------- danh sách bài ----------
function trackRow(t, meta, ...actions) {
  const art = t.thumb
    ? el('img', { src: t.thumb, alt: '', loading: 'lazy' })
    : el('div', { className: 'ph', textContent: t.source === 'file' ? '🎵' : '▶' });
  return el('li', { className: 'row' },
    art,
    el('div', { className: 'info' },
      el('div', { className: 'title', textContent: t.title }),
      el('div', { className: 'muted small', textContent: meta })),
    el('div', { className: 'actions' }, ...actions));
}
// Nút thêm: báo trước những bài chắc chắn không thêm được (quá dài, đang có trong phòng).
function addButton(v) {
  const inRoom = state && (state.current?.videoId === v.videoId || state.queue.some(t => t.videoId === v.videoId));
  const tooLong = state?.maxDurationSec && v.durationSec > state.maxDurationSec;
  if (inRoom || tooLong) {
    return el('button', { type: 'button', className: 'add-btn', disabled: true, textContent: inRoom ? 'Đang có' : 'Quá dài',
      title: inRoom ? 'Bài này đang phát hoặc đã có trong hàng chờ' : `Bài dài hơn ${state.maxDurationSec / 60} phút` });
  }
  const add = el('button', { type: 'button', className: 'add-btn', textContent: '＋ Thêm', title: 'Thêm vào hàng chờ' });
  add.onclick = async () => {
    add.disabled = true;
    const note = $('note').value.trim();
    const r = await act('addTrack', { videoId: v.videoId, note });
    if (r.ok) { add.textContent = '✓ Đã thêm'; add.classList.add('done'); toast('Đã thêm: ' + v.title); $('note').value = ''; }
    else add.disabled = false;
  };
  return add;
}
const resultItem = v => trackRow(v, `${v.source === 'file' ? '📁 ' : ''}${v.channel} · ${fmt(v.durationSec)}`, addButton(v));

// ---------- tìm kiếm + playlist ----------
let lastResults = [];
$('search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  $('btn-add-all').hidden = true;
  $('results-box').hidden = false;
  $('results-info').textContent = `Đang tìm “${q}”…`;
  $('results').replaceChildren();
  const r = await send('search', { q });
  if (!r.ok) { $('results-box').hidden = true; toast(r.error); return; }
  lastResults = r.results;
  $('results-info').textContent = r.results.length
    ? `${r.playlist ? 'Playlist' : 'Kết quả cho'} “${q.length > 40 ? q.slice(0, 40) + '…' : q}” · ${r.results.length} bài`
    : `Không tìm thấy bài nào cho “${q}”`;
  if (!r.results.length) return;
  if (r.playlist) {
    $('btn-add-all').textContent = `＋ Thêm cả playlist (${r.results.length} bài)`;
    $('btn-add-all').hidden = false;
  }
  $('results').replaceChildren(...r.results.map(resultItem));
});
$('btn-add-all').addEventListener('click', async () => {
  const btn = $('btn-add-all');
  btn.disabled = true;
  let added = 0;
  for (const v of lastResults) {
    const r = await send('addTrack', { videoId: v.videoId });
    if (r.ok) added += 1;
    else if (!/đang phát hoặc đã có/.test(r.error)) { toast(`Đã thêm ${added} bài — dừng vì: ${r.error}`); break; }
  }
  if (added === lastResults.length) toast(`Đã thêm ${added} bài`);
  btn.disabled = false;
  btn.hidden = true;
});

$('btn-clear-results').addEventListener('click', () => {
  $('results-box').hidden = true;
  $('results').replaceChildren();
  $('q').value = '';
  lastResults = [];
});

// ---------- tải mp3 ----------
function readDuration(file) {
  return new Promise(resolve => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(a.duration); };
    a.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    a.src = url;
  });
}
$('file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!/\.mp3$/i.test(file.name)) return toast('Chỉ nhận file .mp3');
  if (file.size > MAX_UPLOAD_BYTES) return toast('File lớn quá 20 MB');
  const duration = await readDuration(file);
  if (!(duration > 0) || !isFinite(duration)) return toast('Không đọc được thời lượng file');
  toast('Đang tải lên…');
  const r = await fetch('/api/upload', {
    method: 'POST',
    body: file,
    headers: {
      'content-type': 'audio/mpeg',
      'x-room-code': saved.get('pn_code', ''),
      'x-user-id': userId,
      'x-duration': String(Math.round(duration)),
      'x-title': encodeURIComponent(file.name.replace(/\.mp3$/i, '')),
    },
  }).then(res => res.json()).catch(() => ({ ok: false, error: 'Tải lên thất bại, thử lại sau' }));
  if (!r.ok) return toast(r.error);
  toast(r.added ? `Đã thêm: ${r.info.title}` : `Đã lưu vào kho, chưa thêm được: ${r.reason}`);
});

// ---------- thẻ (tab) ----------
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => showTab(b.dataset.tab));
}
function showTab(name) {
  activeTab = name;
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
  if (name === 'chat') { markSeen(state?.chat.at(-1)?.at ?? 0); renderChat(); }
  if (name === 'top') loadLeaderboard();
  if (name === 'lyrics') loadLyrics();
}

// ---------- chat ----------
$('chat-form').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('chat-text').value.trim();
  if (!text) return;
  const r = await act('chat', { text });
  if (r.ok) $('chat-text').value = '';
});
function renderChat() {
  const list = state?.chat ?? [];
  const box = $('chat');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.replaceChildren(...list.map(chatItem));
  if (atBottom || activeTab === 'chat') box.scrollTop = box.scrollHeight;
  if (seenChat < 0 || (activeTab === 'chat' && !document.hidden)) markSeen(list.at(-1)?.at ?? 0);
  const unread = list.filter(m => m.at > seenChat && m.name !== myName).length;
  $('chat-badge').hidden = !unread;
  $('chat-badge').textContent = String(unread);
  document.title = unread ? `(${unread}) ${APP_NAME}` : APP_NAME;
  notifyChat(list);
}

const CHAT_REACTS = ['❤️', '😂', '👍', '😮', '🎉'];
const mentionsMe = text => !!myName && text.toLowerCase().includes('@' + myName.toLowerCase());
function chatItem(m) {
  const reacts = Object.entries(m.reacts ?? {}).map(([e, names]) => {
    const b = el('button', { type: 'button', className: `chip${names.includes(myName) ? ' active' : ''}`, textContent: `${e} ${names.length}`, title: names.join(', ') });
    b.onclick = () => act('chatReact', { msgId: m.id, emoji: e });
    return b;
  });
  const pick = el('span', { className: 'react-pick' }, ...CHAT_REACTS.map(e => {
    const b = el('button', { type: 'button', textContent: e, title: 'Thả cảm xúc' });
    b.onclick = () => act('chatReact', { msgId: m.id, emoji: e });
    return b;
  }));
  if (state?.isAdmin) {
    const del = el('button', { type: 'button', textContent: '🗑', title: 'Xoá tin này (chủ phòng)' });
    del.onclick = () => act('adminDeleteChat', { msgId: m.id });
    pick.append(del);
  }
  return el('li', { className: mentionsMe(m.text) && m.name !== myName ? 'to-me' : '' },
    who(m.name, m.avatar), el('span', { className: 'muted small', textContent: ` ${hhmm(m.at)}` }), pick,
    el('div', { textContent: m.text }), reacts.length ? el('div', { className: 'reacts' }, ...reacts) : '');
}

// Gõ @ trong ô chat → gợi ý tên người đang nghe.
const fold = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
let mentionPick = [];
function mentionQuery() {
  const inp = $('chat-text');
  const m = /(^|\s)@([^@]*)$/.exec(inp.value.slice(0, inp.selectionStart));
  return m && m[2].length <= 24 ? m : null;
}
function renderMention() {
  const m = mentionQuery();
  const q = m ? fold(m[2]) : '';
  mentionPick = m ? [...new Set((state?.listeners ?? []).map(l => l.name))].filter(n => n !== myName && fold(n).startsWith(q)).slice(0, 6) : [];
  $('mention').hidden = !mentionPick.length;
  $('mention').replaceChildren(...mentionPick.map((n, i) => {
    const b = el('button', { type: 'button', className: i === 0 ? 'active' : '', textContent: '@' + n });
    b.onmousedown = e => { e.preventDefault(); useMention(n); };
    return b;
  }));
}
function useMention(name) {
  const inp = $('chat-text');
  const before = inp.value.slice(0, inp.selectionStart).replace(/@[^@]*$/, `@${name} `);
  inp.value = before + inp.value.slice(inp.selectionStart);
  inp.setSelectionRange(before.length, before.length);
  inp.focus();
  renderMention();
}
$('chat-text').addEventListener('input', renderMention);
$('chat-text').addEventListener('blur', () => { $('mention').hidden = true; });
$('chat-text').addEventListener('keydown', e => {
  if (!$('mention').hidden && mentionPick.length && (e.key === 'Tab' || e.key === 'Enter')) {
    e.preventDefault();
    useMention(mentionPick[0]);
  } else if (e.key === 'Escape') $('mention').hidden = true;
});

// ---------- báo tin chat ra màn hình (khi không nhìn trang) ----------
let notifiedAt = Date.now();
let notifyBatch = null;
const notifyOn = () => saved.get('pn_notify', '1') === '1' && 'Notification' in window && Notification.permission === 'granted';
function notifyChat(list) {
  const fresh = list.filter(m => m.at > notifiedAt && m.name !== myName);
  if (list.length) notifiedAt = Math.max(notifiedAt, list.at(-1).at);
  if (!fresh.length || !document.hidden || !notifyOn()) return;
  const mention = fresh.some(m => mentionsMe(m.text));
  const now = Date.now();
  // Tin dồn trong 1 phút gộp vào một thông báo; nhắc tên thì báo ngay.
  if (notifyBatch && now - notifyBatch.at < 60_000 && !mention) {
    notifyBatch.count += fresh.length;
    notifyBatch.n.close();
  } else notifyBatch = { at: now, count: fresh.length };
  const last = fresh.at(-1);
  const title = mention ? `💬 ${last.name} nhắc bạn` : notifyBatch.count > 1 ? `💬 ${notifyBatch.count} tin mới — ${APP_NAME}` : `💬 ${last.name}`;
  const n = new Notification(title, { body: notifyBatch.count > 1 && !mention ? `${last.name}: ${last.text}` : last.text, tag: 'pn-chat', icon: '/icon-192.png' });
  n.onclick = () => { window.focus(); showTab('chat'); n.close(); };
  notifyBatch.n = n;
}
function renderBell() {
  const b = $('btn-notify');
  if (!('Notification' in window)) { b.hidden = true; return; }
  b.textContent = notifyOn() ? '🔔 Báo tin chat: bật' : '🔕 Báo tin chat: tắt';
}
$('btn-notify').addEventListener('click', async () => {
  if (notifyOn()) saved.set('pn_notify', '0');
  else {
    saved.set('pn_notify', '1');
    if (Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p === 'denied') toast('Trình duyệt đang chặn thông báo — bấm ổ khoá cạnh địa chỉ web để cho phép');
    }
  }
  renderBell();
});
renderBell();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { notifyBatch = null; if (activeTab === 'chat') renderChat(); }
});

// ---------- xếp hạng tuần ----------
async function loadLeaderboard() {
  const r = await send('leaderboard');
  if (!r.ok) return toast(r.error);
  $('top-week').textContent = `Tuần ${r.week.split('-W')[1]} · xếp theo 👍, bằng nhau thì theo số bài`;
  const m = r.me;
  const stat = (big, small) => el('div', { className: 'me-stat' }, el('b', { textContent: big }), el('span', { textContent: small }));
  $('top-me').replaceChildren(...(m ? [
    el('div', { className: 'me-who' }, who(myName, avatar), el('span', { className: 'muted small', textContent: ` · từ trước tới giờ ${m.all.plays} bài, 👍 ${m.all.likes}` })),
    el('div', { className: 'me-stats3' }, stat(m.rank ? `#${m.rank}` : '—', 'hạng tuần'), stat(String(m.week.plays), 'bài đã chọn'), stat(String(m.week.likes), '👍 nhận được')),
  ] : []));
  const avatarOf = name => state?.listeners.find(l => l.name === name)?.avatar || '🎧';
  const MEDALS = ['🥇', '🥈', '🥉'];
  const empty = text => el('li', { className: 'muted small empty-rank', textContent: text });
  // Bục 3 người đầu: hạng 2 – hạng 1 – hạng 3.
  const top3 = r.people.slice(0, 3);
  $('top-podium').replaceChildren(...[1, 0, 2].filter(i => top3[i]).map(i => {
    const p = top3[i];
    const n = el('div', { className: 'pod-name', textContent: p.name });
    n.style.color = nameColor(p.name);
    return el('div', { className: `pod pod-${i + 1}` },
      el('div', { className: 'pod-av', textContent: avatarOf(p.name) }), n,
      el('div', { className: 'muted small', textContent: `👍 ${p.likes} · ${p.plays} bài` }),
      el('div', { className: 'pod-block', textContent: MEDALS[i] }));
  }));
  const maxP = Math.max(1, ...r.people.map(p => p.likes));
  $('top-people').replaceChildren(...(r.people.length > 3 ? r.people.slice(3).map((p, i) => rankRow(`${i + 4}`, who(p.name, avatarOf(p.name)), `👍 ${p.likes} · ${p.plays} bài`, p.likes / maxP))
    : r.people.length ? [] : [empty('Tuần này chưa ai chọn bài — thêm bài để lên bảng!')]));
  const maxT = Math.max(1, ...r.tracks.map(t => t.likes || t.plays / 10));
  $('top-tracks').replaceChildren(...(r.tracks.length ? r.tracks.map((t, i) =>
    rankRow(MEDALS[i] ?? `${i + 1}`, el('span', { className: 'ellipsis', textContent: t.title }), `👍 ${t.likes} · ${t.plays} lần`, (t.likes || t.plays / 10) / maxT))
    : [empty('Chưa có bài nào tuần này.')]));
  return r;
}
function rankRow(pos, label, meta, ratio) {
  const bar = el('div', { className: 'rank-bar' });
  bar.style.width = `${Math.max(4, ratio * 100)}%`;
  return el('li', { className: 'rank-row' },
    el('span', { className: 'rank-pos', textContent: pos }),
    el('div', { className: 'rank-main' }, el('div', { className: 'rank-label' }, label), el('div', { className: 'rank-track' }, bar)),
    el('span', { className: 'rank-meta muted small', textContent: meta }));
}

// ---------- tổng kết tuần ----------
function showWrap(s) {
  const h = Math.floor(s.sec / 3600);
  const mi = Math.round((s.sec % 3600) / 60);
  const lines = [
    ['🎵', `${s.plays} bài · ${h ? `${h} giờ ` : ''}${mi} phút nhạc · ${s.people} người chọn bài`],
    s.topTrack && ['🏆', `Bài được thích nhất: ${s.topTrack.title} (👍 ${s.topTrack.likes})`],
    s.topPerson && ['🌟', `Người chọn bài hay nhất: ${s.topPerson.name} (👍 ${s.topPerson.likes} · ${s.topPerson.plays} bài)`],
    s.mostPlayed && s.mostPlayed.plays > 1 && ['🔁', `Phát nhiều nhất: ${s.mostPlayed.title} (${s.mostPlayed.plays} lần)`],
    ['👍', `Tổng cộng ${s.likes} lượt thích`],
  ].filter(Boolean);
  const box = $('wrap');
  box.replaceChildren(el('div', { className: 'big', textContent: `📊 Tổng kết tuần ${s.week.split('-W')[1]}` }),
    ...lines.map(([i, t]) => el('div', { className: 'wrap-line', textContent: `${i} ${t}` })),
    el('div', { className: 'muted small', textContent: 'Chạm để đóng · cuối tuần vui vẻ!' }));
  box.hidden = false;
}
$('wrap').addEventListener('click', () => { $('wrap').hidden = true; });
$('btn-wrap').addEventListener('click', async () => {
  const r = await send('leaderboard');
  if (r.ok) showWrap(r.summary); else toast(r.error);
});
// Chiều thứ Sáu từ 16:30, mỗi máy tự hiện tổng kết một lần.
async function autoWrap() {
  const d = new Date();
  if (!joined || d.getDay() !== 5 || d.getHours() * 60 + d.getMinutes() < 16 * 60 + 30) return;
  const r = await send('leaderboard');
  if (!r.ok || !r.summary.plays || saved.get('pn_wrap', '') === r.summary.week) return;
  saved.set('pn_wrap', r.summary.week);
  showWrap(r.summary);
}
setInterval(autoWrap, 60_000);
setTimeout(autoWrap, 5000);

// ---------- playlist ----------
$('pl-form').addEventListener('submit', async e => {
  e.preventDefault();
  const r = await act('playlistSaveQueue', { name: $('pl-name').value });
  if (r.ok) { toast('Đã lưu playlist'); $('pl-name').value = ''; }
});
function playlistItem(p) {
  const load = el('button', { type: 'button', textContent: '▶ Nạp vào hàng chờ' });
  load.onclick = async () => { const r = await act('playlistLoad', { id: p.id }); if (r.ok) toast(`Đã thêm ${r.added} bài`); };
  const plus = el('button', { type: 'button', textContent: '+ bài đang phát', title: 'Thêm bài đang phát vào playlist này' });
  plus.onclick = async () => { const r = await act('playlistAddCurrent', { id: p.id }); if (r.ok) toast(`Đã thêm vào ${p.name}`); };
  plus.disabled = !state.current;
  const actions = [load, plus];
  if (p.mine || state.isAdmin) {
    const del = el('button', { type: 'button', textContent: '🗑', title: 'Xoá playlist' });
    del.onclick = () => { if (confirm(`Xoá playlist "${p.name}"?`)) act('playlistDelete', { id: p.id }); };
    actions.push(del);
  }
  return el('li', { className: 'pl' },
    el('div', { className: 'info' }, el('b', { textContent: `🎶 ${p.name}` }),
      el('div', { className: 'muted small', textContent: `${p.count} bài · ${fmt(p.sec)} · lưu bởi ${p.by}` }),
      el('div', { className: 'muted small ellipsis', textContent: p.titles.join(' · ') })),
    el('div', { className: 'actions' }, ...actions));
}

// ---------- hẹn giờ phát (chủ phòng) ----------
$('sched-days').append(...DAY_NAMES.map(([d, label]) =>
  el('label', {}, el('input', { type: 'checkbox', value: String(d), checked: d >= 1 && d <= 5 }), ` ${label}`)));
$('sched-pl').addEventListener('change', () => { $('sched-link').hidden = !!$('sched-pl').value; });
$('sched-form').addEventListener('submit', async e => {
  e.preventDefault();
  const days = [...$('sched-days').querySelectorAll('input:checked')].map(i => Number(i.value));
  const r = await act('adminSchedule', {
    time: $('sched-time').value, days, label: $('sched-label').value,
    playlistId: $('sched-pl').value, link: $('sched-link').value,
  });
  if (r.ok) { toast('Đã hẹn giờ'); $('sched-label').value = ''; $('sched-link').value = ''; }
});
function renderSchedules() {
  const sel = $('sched-pl');
  const cur = sel.value;
  sel.replaceChildren(el('option', { value: '', textContent: 'Phát 1 bài (dán link) →' }),
    ...state.playlists.map(p => el('option', { value: p.id, textContent: `Playlist: ${p.name}` })));
  sel.value = state.playlists.some(p => p.id === cur) ? cur : '';
  $('sched-link').hidden = !!sel.value;
  $('sched-list').replaceChildren(...state.schedules.map(s => {
    const days = DAY_NAMES.filter(([d]) => s.days.includes(d)).map(([, l]) => l).join(' ');
    const del = el('button', { type: 'button', className: 'link', textContent: 'xoá' });
    del.onclick = () => act('adminScheduleRemove', { id: s.id });
    return el('li', {}, el('span', { textContent: `⏰ ${s.time} (${days}) — ${s.label ? s.label + ': ' : ''}${s.kind === 'playlist' ? '🎶 ' : ''}${s.what} ` }), del);
  }));
}

// ---------- cửa sổ nhạc nổi (Chrome/Edge máy tính) ----------
let pipWin = null;
const PIP_CSS = `body{margin:0;font:13px system-ui,sans-serif;background:#0f1115;color:#e8eaed;padding:10px 12px;display:grid;gap:6px}
.t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.m{color:#9aa0a6;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar{height:4px;background:#2a2f3a;border-radius:2px}.bar div{height:100%;background:#4ade80;border-radius:2px;width:0}
.row{display:flex;gap:6px}button{flex:1;background:#1e2430;color:#e8eaed;border:1px solid #2f3646;border-radius:6px;padding:5px 0;font:inherit;cursor:pointer}
button:hover{background:#273042}button.on{border-color:#4ade80}`;
$('btn-pip').hidden = !('documentPictureInPicture' in window);
$('btn-pip').addEventListener('click', async () => {
  if (pipWin) { pipWin.close(); return; }
  try {
    pipWin = await documentPictureInPicture.requestWindow({ width: 340, height: 150 });
  } catch { return toast('Trình duyệt không mở được cửa sổ nổi'); }
  const d = pipWin.document;
  d.title = APP_NAME;
  d.head.append(Object.assign(d.createElement('style'), { textContent: PIP_CSS }));
  d.body.innerHTML = '<div class="t" id="t"></div><div class="m" id="m"></div><div class="bar"><div id="f"></div></div>'
    + '<div class="row"><button id="p"></button><button id="h" title="Thả tim cho cả phòng">❤️</button><button id="s"></button><button id="v"></button></div>';
  d.getElementById('p').onclick = () => act(state?.current?.paused ? 'resume' : 'pause');
  d.getElementById('h').onclick = () => send('react', { emoji: '❤️' });
  d.getElementById('s').onclick = () => act('skip');
  d.getElementById('v').onclick = () => $('btn-mute').click();
  pipWin.addEventListener('pagehide', () => { pipWin = null; $('btn-pip').textContent = '🪟 Cửa sổ nổi'; });
  $('btn-pip').textContent = '🪟 Đóng cửa sổ nổi';
  updatePip();
});
function updatePip() {
  if (!pipWin || !state) return;
  const d = pipWin.document;
  const c = state.current;
  d.getElementById('t').textContent = c ? c.title : 'Phòng đang im lặng';
  d.getElementById('m').textContent = c ? (c.paused ? `⏸ Tạm dừng bởi ${c.paused.byName}` : `${fmt(Math.min(targetSec(), c.durationSec))} / ${fmt(c.durationSec)} · ${c.auto ? 'tự phát' : c.addedBy}`) : '';
  d.getElementById('f').style.width = c ? `${(Math.min(targetSec(), c.durationSec) / c.durationSec) * 100}%` : '0%';
  d.getElementById('p').textContent = c?.paused ? '▶' : '⏸';
  d.getElementById('s').textContent = `⏭ ${state.skip.count}/${state.skip.needed}`;
  d.getElementById('s').classList.toggle('on', state.skip.votedByMe);
  d.getElementById('v').textContent = $('btn-mute').textContent;
}
setInterval(updatePip, 1000);

// ---------- lời bài ----------
function parseLrc(text) {
  const lines = [];
  for (const raw of String(text ?? '').split('\n')) {
    const m = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/.exec(raw.trim());
    if (m) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() || '♪' });
  }
  return lines;
}
async function loadLyrics() {
  const c = state?.current;
  const box = $('lyrics');
  if (!c) { lyricsFor = null; box.replaceChildren(el('p', { className: 'muted', textContent: 'Chưa có bài nào đang phát.' })); return; }
  if (lyricsFor === c.id) return;
  lyricsFor = c.id;
  lyricLines = [];
  if (c.source === 'file') { box.replaceChildren(el('p', { className: 'muted', textContent: 'Bài tải lên chưa có lời.' })); return; }
  box.replaceChildren(el('p', { className: 'muted', textContent: 'Đang tìm lời…' }));
  const r = await send('lyrics');
  if (lyricsFor !== c.id) return;
  if (!r.ok) { box.replaceChildren(el('p', { className: 'muted', textContent: r.error })); return; }
  if (!r.lyrics) { box.replaceChildren(el('p', { className: 'muted', textContent: 'Chưa tìm thấy lời cho bài này.' })); return; }
  lyricLines = parseLrc(r.lyrics.synced);
  if (lyricLines.length) {
    box.replaceChildren(...lyricLines.map(l => el('p', { textContent: l.text })));
  } else {
    box.replaceChildren(...String(r.lyrics.plain).split('\n').map(t => el('p', { textContent: t || ' ' })));
  }
}
// Thời điểm thật của trình phát trên máy này (không dùng giờ chung của phòng — máy có thể lệch vài giây hoặc vướng quảng cáo).
function playbackSec() {
  const c = state?.current;
  if (!c) return 0;
  if (c.source === 'file' && audioTrackId === c.id && !audio.paused) return audio.currentTime;
  if (playerReady && ytTrackId === c.id) {
    const st = player.getPlayerState();
    if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.PAUSED) return player.getCurrentTime();
  }
  return targetSec();
}
// Độ lệch lời bài theo từng bài, mỗi máy tự nhớ (MV thường có đoạn mở đầu dài hơn bản audio mà lời khớp theo).
const lyricShiftKey = () => `pn_ly_${state?.current?.videoId ?? ''}`;
const lyricShift = () => Number(saved.get(lyricShiftKey(), 0)) || 0;
function nudgeLyrics(delta) {
  const v = Math.round((lyricShift() + delta) * 10) / 10;
  saved.set(lyricShiftKey(), v);
  $('lyrics-shift').textContent = `${v > 0 ? '+' : ''}${v}s`;
  for (const n of $('lyrics').children) delete n.dataset.seen;
  highlightLyrics();
}
$('lyrics-earlier').addEventListener('click', () => nudgeLyrics(-1));
$('lyrics-later').addEventListener('click', () => nudgeLyrics(1));

function highlightLyrics() {
  if (activeTab !== 'lyrics' || !lyricLines.length) return;
  const shift = lyricShift();
  $('lyrics-shift').textContent = `${shift > 0 ? '+' : ''}${shift}s`;
  // Lời chạy trước nhạc → bấm "Lời chậm lại" (+): lời hiện muộn hơn.
  const pos = playbackSec() - shift;
  let idx = -1;
  for (let i = 0; i < lyricLines.length; i++) if (lyricLines[i].t <= pos) idx = i;
  const nodes = $('lyrics').children;
  for (let i = 0; i < nodes.length; i++) nodes[i].classList.toggle('on', i === idx);
  if (idx >= 0 && nodes[idx] && !nodes[idx].dataset.seen) {
    for (const n of nodes) delete n.dataset.seen;
    nodes[idx].dataset.seen = '1';
    nodes[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
setInterval(highlightLyrics, 500);

// ---------- vẽ giao diện ----------
function queueItem(t) {
  const like = el('button', { type: 'button', className: t.votedByMe ? 'active' : '', textContent: `👍 ${t.votes}` });
  like.onclick = () => act('vote', { trackId: t.id });
  const actions = [like];
  if (t.mine || state.isAdmin) {
    const del = el('button', { type: 'button', textContent: '🗑', title: 'Xoá khỏi hàng chờ' });
    del.onclick = () => act('remove', { trackId: t.id });
    actions.push(del);
  }
  return trackRow(t, `${fmt(t.durationSec)} · ${t.addedBy}${t.note ? ` · 💌 ${t.note}` : ''}`, ...actions);
}
const historyItem = h => trackRow(h, `${hhmm(h.playedAt)} · ${h.addedBy}`, addButton(h));

function renderTime() {
  const c = state?.current;
  if (!c) {
    $('now-time').textContent = '';
    $('progress-fill').style.width = '0%';
    return;
  }
  const pos = Math.min(targetSec(), c.durationSec);
  $('now-time').textContent = `${fmt(pos)} / ${fmt(c.durationSec)}`;
  $('progress-fill').style.width = `${(pos / c.durationSec) * 100}%`;
}
setInterval(renderTime, 1000);

// ---------- bài tiếp theo (15 giây cuối) ----------
function renderNextUp() {
  const c = state?.current;
  const box = $('next-up');
  const left = c ? c.durationSec - Math.min(targetSec(), c.durationSec) : Infinity;
  if (!c || c.paused || left > 15) { box.hidden = true; return; }
  const n = state.queue[0];
  box.hidden = false;
  box.textContent = n ? `⏭ Tiếp theo sau ${Math.ceil(left)}s: ${n.title} — ${n.addedBy}`
    : state.autoFill ? `⏭ Còn ${Math.ceil(left)}s — hàng chờ trống, phòng sẽ tự phát bài cũ` : `⏭ Còn ${Math.ceil(left)}s — hàng chờ trống, thêm bài đi!`;
}
setInterval(renderNextUp, 1000);

// ---------- bình chọn ----------
function renderPoll() {
  const p = state.poll;
  const box = $('poll');
  box.hidden = !p;
  if (!p) return;
  const total = p.options.reduce((n, o) => n + o.count, 0);
  const opts = p.options.map((o, i) => {
    const pct = total ? Math.round((o.count / total) * 100) : 0;
    const b = el('button', { type: 'button', className: `poll-opt${p.myVote === i ? ' active' : ''}`, disabled: !p.open });
    const fill = el('span', { className: 'poll-fill' });
    fill.style.width = `${pct}%`;
    b.append(fill, el('span', { className: 'poll-text', textContent: `${p.myVote === i ? '✓ ' : ''}${o.text}` }), el('span', { className: 'poll-count', textContent: `${o.count} · ${pct}%` }));
    b.onclick = () => act('pollVote', { index: i });
    return b;
  });
  const head = el('div', { className: 'poll-head' }, el('b', { textContent: `🗳 ${p.question}` }),
    el('span', { className: 'muted small', textContent: p.open ? ` · ${total} phiếu · bấm để chọn, bấm lại để rút` : ` · đã chốt · ${total} phiếu` }));
  const kids = [head, ...opts];
  if (state.isAdmin) {
    const end = el('button', { type: 'button', className: 'link', textContent: p.open ? 'Chốt kết quả' : 'Ẩn bình chọn' });
    end.onclick = () => act('adminPollEnd', {});
    kids.push(end);
  }
  box.replaceChildren(...kids);
}
$('poll-form').addEventListener('submit', async e => {
  e.preventDefault();
  const options = $('poll-opts').value.split(',').map(s => s.trim()).filter(Boolean);
  const r = await act('adminPoll', { question: $('poll-q').value, options });
  if (r.ok) { $('poll-q').value = ''; $('poll-opts').value = ''; }
});

// ---------- mã QR vào phòng ----------
$('btn-qr').addEventListener('click', () => {
  const code = saved.get('pn_code', '');
  const url = `${location.origin}/${code ? `?ma=${encodeURIComponent(code)}` : ''}`;
  const box = $('qr');
  const img = el('div', { className: 'qr-img' });
  if (typeof qrcode === 'function') {
    const q = qrcode(0, 'M');
    q.addData(url);
    q.make();
    img.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }
  box.replaceChildren(el('div', { className: 'big', textContent: `📱 Quét để vào ${APP_NAME}` }), img,
    el('div', { className: 'small', textContent: url }),
    el('div', { className: 'muted small', textContent: code ? 'Mã phòng đã nằm sẵn trong mã QR · chạm để đóng' : 'Chạm để đóng' }));
  box.hidden = false;
});
$('qr').addEventListener('click', () => { $('qr').hidden = true; });

function render() {
  if (!state) return;
  const c = state.current;
  const wrap = $('player-wrap');
  wrap.classList.toggle('empty', !c || c.source === 'file');
  wrap.dataset.label = !c ? 'Phòng đang im lặng' : '🎵 Bài mp3 — nghe được cả khi tắt màn hình';
  $('join-now').textContent = c ? `Đang phát: ${c.title}` : 'Phòng đang im lặng.';
  $('now-title').textContent = c ? c.title : 'Chưa có bài nào — tìm và thêm bài ở ô "Thêm bài"';
  $('now-meta').textContent = c ? `${c.channel} · ${c.auto ? '🔁 tự phát' : `chọn bởi ${c.addedBy}`}` : '';
  $('now-note').hidden = !c?.note;
  $('now-note').textContent = c?.note ? `💌 ${c.note}` : '';
  const bd = state.birthdaysToday ?? [];
  const topBar = [state.theme && `🎯 Chủ đề: ${state.theme}`, bd.length && `🎂 Hôm nay sinh nhật ${bd.join(', ')} — chúc mừng nhé!`].filter(Boolean);
  $('theme-bar').hidden = !topBar.length;
  $('theme-bar').textContent = topBar.join('  ·  ');
  announceNote(c);
  $('btn-pause').disabled = !c;
  // Không phủ lên trình phát YouTube (điều khoản YouTube: trình phát nhúng phải luôn nhìn thấy được).
  $('btn-dim').hidden = c?.source !== 'file';
  if (c?.source !== 'file' && !$('dim').hidden) exitDim();
  $('btn-skip').disabled = !c;
  $('btn-pause').textContent = c?.paused ? '▶ Phát tiếp' : '⏸ Tạm dừng';
  const bar = $('paused-bar');
  bar.hidden = !c?.paused;
  if (c?.paused) bar.textContent = `⏸ Tạm dừng bởi ${c.paused.byName} · ${hhmm(c.paused.since)}`;
  const sk = state.skip;
  $('btn-skip').textContent = `Bỏ qua (${sk.count}/${sk.needed})`;
  $('btn-skip').classList.toggle('active', sk.votedByMe);

  renderPoll();
  renderNextUp();
  $('queue').replaceChildren(...state.queue.map(queueItem));
  $('queue-empty').hidden = state.queue.length > 0;
  $('queue-empty').textContent = state.locked ? '🔒 Chủ phòng đang khoá thêm bài.' : 'Hàng chờ trống.';
  $('history').replaceChildren(...state.history.map(historyItem));
  $('playlists').replaceChildren(...(state.playlists.length ? state.playlists.map(playlistItem)
    : [el('li', { className: 'muted small', textContent: 'Chưa có playlist nào — xếp hàng chờ rồi bấm Lưu.' })]));
  if (state.isAdmin) renderSchedules();
  updatePip();
  renderChat();
  if (activeTab === 'lyrics') loadLyrics();

  $('listeners-sum').textContent = `Đang nghe: ${state.listeners.length} người`;
  $('listeners').replaceChildren(...state.listeners.map(l => el('li', {}, who(l.name, l.avatar))));
  if (state.isAdmin) $('ap-people').replaceChildren(...state.listeners.map(listenerItem));
  const bu = state.blockedUntil;
  $('blocked-bar').hidden = !(bu > serverNow());
  if (bu > serverNow()) $('blocked-bar').textContent = `🚫 Chủ phòng đang tạm chặn bạn thêm bài / chat tới ${hhmm(bu)}`;
  $('status-box').hidden = !state.isAdmin;
  if (state.isAdmin) renderBlocked();
  $('quiet-info').textContent = quietText(state.quiet);

  $('admin-bar').hidden = !state.isAdmin;
  $('quiet-form').hidden = !state.isAdmin;
  $('btn-admin').hidden = state.isAdmin;
  apToggle('btn-lock', state.locked, '🔓', 'Đang khoá thêm bài', 'bấm để mở cho mọi người', '🔒', 'Khoá thêm bài', 'chỉ chủ phòng thêm được');
  apToggle('btn-autofill', state.autoFill, '🔁', 'Tự phát: BẬT', 'hàng chờ trống tự phát', '⏹', 'Tự phát: TẮT', 'hàng chờ trống thì im lặng');
  if (state.isAdmin) {
    const sel = $('fill-src');
    sel.replaceChildren(el('option', { value: '', textContent: 'Lịch sử (bài hay)' }),
      ...state.playlists.map(p => el('option', { value: p.id, textContent: `Playlist: ${p.name}` })));
    sel.value = state.fillPlaylistId;
    $('bday-song-now').textContent = state.birthdaySong ? `Đang dùng: ${state.birthdaySong}` : 'Chưa chọn bài — tới sinh nhật chỉ hiện lời chúc.';
    $('sched-empty').hidden = state.schedules.length > 0;
  }
  $('btn-bday').textContent = state.myBirthday ? `🎂 Sinh nhật: ${state.myBirthday.split('-').reverse().join('/')}` : '🎂 Sinh nhật';
  if (state.isAdmin) {
    fillQuietForm(state.quiet);
    if (document.activeElement !== $('theme-text')) $('theme-text').value = state.theme;
  }
  renderTime();
}

// ---------- bảng chủ phòng ----------
function apToggle(id, on, ie1, t1, s1, ie0, t0, s0) {
  const b = $(id);
  b.classList.toggle('on', on);
  b.replaceChildren(el('span', { textContent: on ? ie1 : ie0 }), el('b', { textContent: on ? t1 : t0 }), el('small', { textContent: on ? s1 : s0 }));
}
function showApTab(name) {
  for (const b of document.querySelectorAll('.ap-tabs button')) b.classList.toggle('active', b.dataset.ap === name);
  for (const p of document.querySelectorAll('[data-ap-panel]')) p.hidden = p.dataset.apPanel !== name;
  saved.set('pn_ap_tab', name);
  if (name === 'system') loadStatus();
}
for (const b of document.querySelectorAll('.ap-tabs button')) b.addEventListener('click', () => showApTab(b.dataset.ap));
showApTab(saved.get('pn_ap_tab', 'vibe'));
$('btn-admin-out').addEventListener('click', () => {
  if (!confirm('Thoát chế độ chủ phòng trên máy này? Muốn vào lại phải nhập mã chủ phòng.')) return;
  saved.del('pn_admin');
  location.reload();
});

// ---------- chủ phòng: chặn tạm + tình trạng phòng ----------
function listenerItem(l) {
  const li = el('li', {}, who(l.name, l.avatar));
  if (!state.isAdmin || !l.id || l.id === userId) return li;
  if (l.blockedUntil > serverNow()) {
    const ub = el('button', { type: 'button', className: 'mini', textContent: `Bỏ chặn (tới ${hhmm(l.blockedUntil)})` });
    ub.onclick = () => act('adminUnblock', { userId: l.id });
    li.append(ub);
  } else {
    const b = el('button', { type: 'button', className: 'mini', textContent: '🚫 Chặn 1 giờ' });
    b.onclick = () => { if (confirm(`Chặn ${l.name} thêm bài / chat trong 1 giờ? Bài đang chờ của họ sẽ bị xoá.`)) act('adminBlock', { userId: l.id, minutes: 60 }); };
    li.append(b);
  }
  return li;
}
function renderBlocked() {
  const list = state.blocked.filter(b => b.until > serverNow());
  $('blocked-empty').hidden = list.length > 0;
  $('blocked-list').replaceChildren(...(list.length ? [...list.map(b => {
    const ub = el('button', { type: 'button', className: 'link', textContent: 'bỏ chặn' });
    ub.onclick = () => act('adminUnblock', { userId: b.id });
    return el('div', { className: 'small' }, `🚫 ${b.name} — tới ${hhmm(b.until)} `, ub);
  })] : []));
}
const mb = n => (n / 1048576).toFixed(n < 104857600 ? 1 : 0);
const dur = s => { s = Math.floor(s); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return `${d ? d + ' ngày ' : ''}${h ? h + ' giờ ' : ''}${m} phút`; };
async function loadStatus() {
  const r = await send('adminStatus');
  if (!r.ok) return;
  const row = (k, v, warn = false) => el('div', { className: `st-row${warn ? ' st-warn' : ''}` }, el('span', { className: 'muted', textContent: k }), el('b', { textContent: v }));
  const yt = r.yt;
  const lib = r.library;
  const bk = r.backup;
  $('status-body').replaceChildren(...[
    row('Đã chạy', dur((r.now - r.startedAt) / 1000)),
    row('Người nghe', `${r.listeners.length} người · ${r.sockets} tab mở`),
    row('Đang nghe', r.listeners.map(l => l.tabs > 1 ? `${l.name} (${l.tabs} tab)` : l.name).join(', ') || '—'),
    yt && row('Lượt YouTube hôm nay', `${yt.units.toLocaleString('vi-VN')} / 10.000${yt.quotaHit ? ' · ĐÃ HẾT' : ''} (≈ ${Math.max(0, Math.floor((10000 - yt.units) / 101))} lần tìm nữa)`, yt.quotaHit || yt.units > 8000),
    lib && row('Kho mp3', `${lib.files} bài · ${mb(lib.bytes)} MB / ${mb(lib.max)} MB`, lib.bytes > lib.max * 0.9),
    bk && row('Sao lưu', bk.error ? `LỖI: ${bk.error}` : bk.last ? `gần nhất ${bk.last} · đang giữ ${bk.count}/${bk.keep} ngày` : 'chưa có bản nào', !!bk.error || !bk.last),
    row('Dữ liệu', `${r.counts.history} bài lịch sử · ${r.counts.playlists} playlist · ${r.counts.schedules} lịch hẹn`),
    row('Bộ nhớ máy chủ', `${r.memMB} MB`),
    row('Giờ yên lặng', r.quietNow ? 'đang yên lặng' : 'đang trong giờ phát'),
  ].filter(Boolean)
  );
}
$('btn-status').addEventListener('click', loadStatus);
setInterval(() => { if (state?.isAdmin && !document.hidden) loadStatus(); }, 30_000);
let statusLoaded = false;
socket.on('state', () => { if (state?.isAdmin && !statusLoaded) { statusLoaded = true; loadStatus(); } });

// ---------- tự phát theo playlist, sinh nhật, huy hiệu ----------
$('fill-src').addEventListener('change', async () => {
  const r = await act('adminFillPlaylist', { id: $('fill-src').value });
  if (r.ok) toast($('fill-src').value ? 'Hàng chờ trống sẽ tự phát từ playlist này' : 'Hàng chờ trống sẽ tự phát từ lịch sử');
});
$('bday-song-form').addEventListener('submit', async e => {
  e.preventDefault();
  const r = await act('adminBirthdaySong', { link: $('bday-song').value });
  if (r.ok) { toast(r.title ? `Bài sinh nhật: ${r.title}` : 'Sinh nhật sẽ chỉ chúc, không phát bài'); $('bday-song').value = ''; }
});
$('btn-bday').addEventListener('click', async () => {
  const cur = state?.myBirthday ? state.myBirthday.split('-').reverse().join('/') : '';
  const v = prompt('Ngày sinh của bạn (ngày/tháng, ví dụ 25/12). Chỉ lưu ngày và tháng. Để trống để xoá.', cur);
  if (v === null) return;
  const m = /^\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*$/.exec(v);
  if (v.trim() && !m) return toast('Gõ theo dạng ngày/tháng, ví dụ 25/12');
  const md = m ? `${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
  const r = await act('setBirthday', { md });
  if (r.ok) toast(md ? 'Đã lưu — tới ngày phòng sẽ chúc mừng bạn 🎂' : 'Đã xoá ngày sinh');
});
$('btn-badges').addEventListener('click', () => toast('🏆 DJ của tuần (nhiều 👍 nhất) · 🧭 Người khai phá (5 bài lần đầu vào phòng/tuần) · ❤️ Được yêu thích (20 👍/tuần) · 🔥 Chăm chỉ (5 ngày làm liền) · 🎂 Sinh nhật hôm nay'));

// ---------- cài như app (PWA) ----------
let installEvent = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  $('btn-install').hidden = false;
});
$('btn-install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('btn-install').hidden = true;
});
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
$('ios-hint').hidden = !(isIOS && !standalone);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
