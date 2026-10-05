import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { Room } from '../server/room.js';
import { createApp } from '../server/app.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLibrary } from '../server/library.js';

const VIDEO = { videoId: 'aaaaaaaaaaa', title: 'Bài A', channel: 'Kênh', thumb: '', durationSec: 200, embeddable: true };
const VIDEO2 = { ...VIDEO, videoId: 'bbbbbbbbbbb', title: 'Bài B' };
const fakeYt = {
  async getVideo(id) { return [VIDEO, VIDEO2].find(v => v.videoId === id) ?? null; },
  async search() { return [VIDEO, VIDEO2]; },
};

async function setup(roomCode = '') {
  const room = new Room();
  room.quiet.enabled = false; // kiểm thử chạy bằng giờ thật — không để giờ yên lặng xen vào
  const library = createLibrary(fs.mkdtempSync(path.join(os.tmpdir(), 'unison-app-')));
  const app = createApp({ room, yt: fakeYt, store: { save() {}, flush() {} }, library, roomCode, adminCode: 'boss99', log: { error() {} } });
  const port = await app.listen(0, '127.0.0.1');
  const clients = [];
  const client = (code = '') => {
    const c = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, auth: { code } });
    c.on('state', s => { c.last = s; });
    clients.push(c);
    return c;
  };
  const close = async () => { for (const c of clients) c.close(); await app.close(); };
  return { client, close, port, room };
}
const emit = (c, ev, payload) => new Promise(r => c.emit(ev, payload, r));
const settle = c => emit(c, 'ping', { t0: 0 });

test('vào phòng, thêm bài, mọi máy cùng thấy bài đang phát', async () => {
  const { client, close } = await setup();
  try {
    const a = client(), b = client();
    assert.equal((await emit(a, 'addTrack', { videoId: VIDEO.videoId })).ok, false);
    assert.deepEqual(await emit(a, 'join', { userId: 'user-aaaa', name: '  An  ' }), { ok: true, name: 'An' });
    await emit(b, 'join', { userId: 'user-bbbb', name: 'Bình' });
    assert.equal((await emit(a, 'addTrack', { videoId: VIDEO.videoId })).ok, true);
    await settle(b);
    assert.equal(b.last.current.title, 'Bài A');
    assert.equal(b.last.current.addedBy, 'An');
    assert.deepEqual(b.last.listeners.map(l => l.name).sort(), ['An', 'Bình']);
    const dup = await emit(b, 'addTrack', { videoId: VIDEO.videoId });
    assert.equal(dup.ok, false);
    assert.match(dup.error, /hàng chờ/);
  } finally { await close(); }
});

test('tạm dừng từ một máy thì máy khác thấy tên người dừng', async () => {
  const { client, close } = await setup();
  try {
    const a = client(), b = client();
    await emit(a, 'join', { userId: 'user-aaaa', name: 'An' });
    await emit(b, 'join', { userId: 'user-bbbb', name: 'Bình' });
    await emit(a, 'addTrack', { videoId: VIDEO.videoId });
    await emit(b, 'pause');
    await settle(a);
    assert.equal(a.last.current.paused.byName, 'Bình');
    await emit(a, 'resume');
    await settle(b);
    assert.equal(b.last.current.paused, null);
  } finally { await close(); }
});

test('bỏ qua theo số đông; người rời phòng làm ngưỡng giảm', async () => {
  const { client, close } = await setup();
  try {
    const a = client(), b = client(), c = client(), d = client();
    await emit(a, 'join', { userId: 'user-aaaa', name: 'An' });
    await emit(b, 'join', { userId: 'user-bbbb', name: 'Bình' });
    await emit(c, 'join', { userId: 'user-cccc', name: 'Chi' });
    await emit(d, 'join', { userId: 'user-dddd', name: 'Dũng' });
    await emit(a, 'addTrack', { videoId: VIDEO.videoId });
    await emit(a, 'addTrack', { videoId: VIDEO2.videoId });
    await emit(a, 'skip');
    await emit(b, 'skip');
    await settle(a);
    assert.deepEqual(a.last.skip, { count: 2, needed: 3, votedByMe: true });
    assert.equal(a.last.current.title, 'Bài A');
    d.close();
    await new Promise(r => setTimeout(r, 100));
    await settle(a);
    assert.equal(a.last.current.title, 'Bài B');
  } finally { await close(); }
});

test('dữ liệu rác không làm sập máy chủ; ping trả giờ máy chủ', async () => {
  const { client, close } = await setup();
  try {
    const a = client();
    assert.equal((await emit(a, 'join', 'rác')).ok, false);
    assert.equal((await emit(a, 'join', { userId: 'x', name: 'An' })).ok, false);
    assert.equal((await emit(a, 'join', { userId: 'user-aaaa', name: '   ' })).ok, false);
    await emit(a, 'join', { userId: 'user-aaaa', name: 'An' });
    assert.equal((await emit(a, 'vote', null)).ok, false);
    assert.equal((await emit(a, 'search', { q: 42 })).ok, false);
    const p = await emit(a, 'ping', { t0: 5 });
    assert.equal(p.t0, 5);
    assert.ok(Math.abs(p.serverNow - Date.now()) < 1000);
    const s1 = await emit(a, 'search', { q: 'lạc trôi' });
    assert.equal(s1.results.length, 2);
    assert.match((await emit(a, 'search', { q: 'khác' })).error, /Chậm lại/);
    const link = await emit(a, 'search', { q: 'https://youtu.be/bbbbbbbbbbb' });
    assert.deepEqual(link.results.map(v => v.videoId), ['bbbbbbbbbbb']);
  } finally { await close(); }
});

test('có mã phòng: sai mã bị từ chối, đúng mã vào được', async () => {
  const { client, close } = await setup('123456');
  try {
    const bad = client('999');
    const err = await new Promise(r => bad.once('connect_error', r));
    assert.equal(err.message, 'bad_code');
    const good = client('123456');
    assert.equal((await emit(good, 'join', { userId: 'user-aaaa', name: 'An' })).ok, true);
  } finally { await close(); }
});

test('chủ phòng: sai mã bị từ chối; đúng mã thì khoá thêm bài, chuyển bài ngay', async () => {
  const { client, close } = await setup();
  try {
    const a = client(), b = client();
    await emit(a, 'join', { userId: 'user-aaaa', name: 'An' });
    await emit(b, 'join', { userId: 'user-bbbb', name: 'Bình' });
    assert.equal((await emit(b, 'adminLock', { value: true })).ok, false);
    assert.equal((await emit(a, 'admin', { code: 'sai' })).ok, false);
    assert.equal((await emit(a, 'admin', { code: 'boss99' })).ok, true);
    await emit(a, 'addTrack', { videoId: VIDEO.videoId });
    await emit(a, 'addTrack', { videoId: VIDEO2.videoId });
    assert.equal((await emit(a, 'adminLock', { value: true })).ok, true);
    assert.match((await emit(b, 'addTrack', { videoId: 'ccccccccccc' })).error ?? '', /khoá|Không tìm thấy/);
    await emit(a, 'adminSkip');
    assert.equal(a.last.current.title, 'Bài B');
    assert.equal(a.last.isAdmin, true);
    await settle(b);
    assert.equal(b.last.isAdmin, false);
    assert.equal(b.last.locked, true);
  } finally { await close(); }
});

test('chat và thả cảm xúc tới mọi máy', async () => {
  const { client, close } = await setup();
  try {
    const a = client(), b = client();
    await emit(a, 'join', { userId: 'user-aaaa', name: 'An' });
    await emit(b, 'join', { userId: 'user-bbbb', name: 'Bình' });
    const got = new Promise(r => b.once('reaction', r));
    await emit(a, 'react', { emoji: '🔥' });
    assert.deepEqual(await got, { emoji: '🔥', name: 'An' });
    assert.equal((await emit(a, 'react', { emoji: 'x' })).ok, false);
    await emit(a, 'chat', { text: 'chào cả nhà' });
    await settle(b);
    assert.equal(b.last.chat.at(-1).text, 'chào cả nhà');
    assert.equal((await emit(a, 'leaderboard')).ok, true);
  } finally { await close(); }
});

test('tải mp3: phải vào phòng, chỉ nhận mp3, thêm vào hàng chờ và phát được qua /files', async () => {
  const { client, close, port } = await setup();
  try {
    const a = client();
    await emit(a, 'join', { userId: 'user-aaaa', name: 'An' });
    const up = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/upload`, {
      method: 'POST', body, headers: { 'x-user-id': 'user-aaaa', 'x-duration': '123', 'x-title': encodeURIComponent('Bài của An'), ...headers },
    }).then(r => r.json());
    assert.equal((await up(Buffer.from('ID3abc'), { 'x-user-id': 'nguoi-la-123' })).ok, false);
    assert.match((await up(Buffer.from('<html>'))).error, /mp3/);
    const r = await up(Buffer.from('ID3' + 'x'.repeat(100)));
    assert.equal(r.ok, true);
    assert.equal(r.added, true);
    await settle(a);
    assert.equal(a.last.current.title, 'Bài của An');
    assert.equal(a.last.current.source, 'file');
    const f = await fetch(`http://127.0.0.1:${port}${a.last.current.src}`);
    assert.equal(f.status, 200);
  } finally { await close(); }
});

test('tặng bài, chủ đề, chúc mừng phát ngay, thống kê cá nhân', async () => {
  const { client, close } = await setup();
  try {
    const a = client(), b = client();
    await emit(a, 'join', { userId: 'user-aaaa', name: 'An', avatar: '🐱' });
    await emit(b, 'join', { userId: 'user-bbbb', name: 'Bình', avatar: 'không hợp lệ' });
    await emit(a, 'addTrack', { videoId: VIDEO.videoId, note: 'Tặng cả nhà' });
    await settle(b);
    assert.equal(b.last.current.note, 'Tặng cả nhà');
    assert.deepEqual(b.last.listeners.find(l => l.name === 'Bình'), { name: 'Bình', avatar: '' });
    assert.equal((await emit(b, 'adminTheme', { text: 'x' })).ok, false);
    await emit(a, 'admin', { code: 'boss99' });
    await emit(a, 'adminTheme', { text: 'Thứ 6 sôi động' });
    const cele = new Promise(r => b.once('celebrate', r));
    assert.equal((await emit(a, 'adminCelebrate', { text: 'Sinh nhật chị Lan 🎂', link: 'https://youtu.be/bbbbbbbbbbb' })).ok, true);
    assert.deepEqual(await cele, { text: 'Sinh nhật chị Lan 🎂', by: 'An' });
    await settle(b);
    assert.equal(b.last.theme, 'Thứ 6 sôi động');
    assert.equal(b.last.current.title, 'Bài B');
    const lb = await emit(a, 'leaderboard');
    assert.equal(lb.me.week.plays >= 1, true);
  } finally { await close(); }
});

test('chống dò mã chủ phòng: sai 5 lần thì khoá, nhập đúng cũng bị từ chối', async () => {
  const { client, close } = await setup();
  try {
    const a = client();
    await emit(a, 'join', { userId: 'user-aaaa', name: 'An' });
    for (let i = 0; i < 4; i++) assert.match((await emit(a, 'admin', { code: 'sai' })).error, /không đúng/);
    assert.match((await emit(a, 'admin', { code: 'sai' })).error, /nhiều lần/);
    assert.match((await emit(a, 'admin', { code: 'boss99' })).error, /nhiều lần/);
  } finally { await close(); }
});

test('chống dò mã phòng: sai 5 lần thì kết nối đúng mã cũng bị chặn', async () => {
  const { client, close } = await setup('1234');
  try {
    const errOf = c => new Promise(r => { c.on('connect_error', e => r(e.message)); c.on('connect', () => r('connected')); });
    for (let i = 0; i < 4; i++) assert.equal(await errOf(client('0000')), 'bad_code');
    assert.equal(await errOf(client('0000')), 'too_many_tries');
    assert.equal(await errOf(client('1234')), 'too_many_tries');
  } finally { await close(); }
});

test('header bảo mật có trên trang chủ', async () => {
  const { close, port } = await setup();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-powered-by'), null);
  } finally { await close(); }
});
