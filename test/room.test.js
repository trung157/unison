import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';

const A = { userId: 'user-aaaa', name: 'An' };
const B = { userId: 'user-bbbb', name: 'Bình' };
const C = { userId: 'user-cccc', name: 'Chi' };
const D = { userId: 'user-dddd', name: 'Dũng' };
const vid = (n, extra = {}) => ({
  videoId: `vid${String(n).padStart(8, '0')}`, title: `Bài ${n}`, channel: 'Kênh',
  thumb: '', durationSec: 180, embeddable: true, ...extra,
});
function roomWith(...users) {
  const r = new Room();
  for (const u of users) r.join(u.userId, u.name);
  return r;
}

test('bài đầu tiên phát ngay, bài sau vào hàng chờ', () => {
  const r = roomWith(A);
  assert.equal(r.addTrack(vid(1), A, 1000).ok, true);
  assert.equal(r.current.videoId, vid(1).videoId);
  assert.equal(r.current.startedAt, 1000);
  assert.equal(r.current.paused, null);
  r.addTrack(vid(2), A, 2000);
  assert.equal(r.queue.length, 1);
});

test('từ chối video cấm nhúng, phát trực tiếp, quá dài', () => {
  const r = roomWith(A);
  assert.equal(r.addTrack(vid(1, { embeddable: false }), A, 0).error, 'not_embeddable');
  assert.equal(r.addTrack(vid(2, { durationSec: 0 }), A, 0).error, 'live');
  assert.equal(r.addTrack(vid(3, { durationSec: 15 * 60 + 1 }), A, 0).error, 'too_long');
  assert.equal(r.addTrack(vid(4, { durationSec: 15 * 60 }), A, 0).ok, true);
});

test('từ chối bài trùng với bài đang phát hoặc đang chờ', () => {
  const r = roomWith(A, B);
  r.addTrack(vid(1), A, 0);
  r.addTrack(vid(2), A, 0);
  assert.equal(r.addTrack(vid(1), B, 0).error, 'duplicate');
  assert.equal(r.addTrack(vid(2), B, 0).error, 'duplicate');
});

test('mỗi người tối đa 5 bài đang chờ, bài đang phát không tính', () => {
  const r = roomWith(A);
  for (let i = 0; i <= 5; i++) assert.equal(r.addTrack(vid(i), A, i).ok, true);
  assert.equal(r.queue.length, 5);
  assert.equal(r.addTrack(vid(9), A, 9).error, 'too_many');
});

test('hàng chờ xếp theo 👍 rồi theo giờ thêm; bấm lại thì rút phiếu', () => {
  const r = roomWith(A, B, C);
  r.addTrack(vid(0), C, 0);
  const t1 = r.addTrack(vid(1), A, 10).track;
  const t2 = r.addTrack(vid(2), B, 20).track;
  assert.deepEqual(r.sortedQueue().map(t => t.id), [t1.id, t2.id]);
  r.vote(t2.id, A.userId);
  assert.deepEqual(r.sortedQueue().map(t => t.id), [t2.id, t1.id]);
  r.vote(t2.id, A.userId);
  assert.deepEqual(r.sortedQueue().map(t => t.id), [t1.id, t2.id]);
  assert.equal(r.vote('t999', A.userId).error, 'not_found');
});

test('chỉ người thêm bài mới xoá được', () => {
  const r = roomWith(A, B);
  r.addTrack(vid(0), A, 0);
  const t = r.addTrack(vid(1), A, 0).track;
  assert.equal(r.remove(t.id, B.userId).error, 'not_owner');
  assert.equal(r.remove(t.id, A.userId).ok, true);
  assert.equal(r.queue.length, 0);
  assert.equal(r.remove(t.id, A.userId).error, 'not_found');
});

test('bỏ qua cần quá nửa người nghe, bài sau bắt đầu từ lúc chuyển', () => {
  const r = roomWith(A, B, C);
  r.addTrack(vid(1), A, 0);
  r.addTrack(vid(2), A, 0);
  assert.equal(r.skipNeeded, 2);
  r.skip(A.userId, 100);
  assert.equal(r.current.videoId, vid(1).videoId);
  r.skip(B.userId, 200);
  assert.equal(r.current.videoId, vid(2).videoId);
  assert.equal(r.current.startedAt, 200);
  assert.equal(r.skipVotes.size, 0);
});

test('bấm bỏ qua lần nữa thì rút phiếu', () => {
  const r = roomWith(A, B, C);
  r.addTrack(vid(1), A, 0);
  r.skip(A.userId, 1);
  r.skip(A.userId, 2);
  assert.equal(r.skipVotes.size, 0);
});

test('người rời phòng làm ngưỡng giảm thì bỏ qua luôn', () => {
  const r = roomWith(A, B, C, D);
  r.addTrack(vid(1), A, 0);
  r.addTrack(vid(2), A, 0);
  r.skip(A.userId, 1);
  r.skip(B.userId, 2);
  assert.equal(r.current.videoId, vid(1).videoId);
  r.leave(D.userId, 3);
  assert.equal(r.current.videoId, vid(2).videoId);
});

test('mở 2 tab chỉ tính 1 người, đóng hết tab mới rời phòng', () => {
  const r = roomWith(A);
  r.join(A.userId, 'An mới');
  assert.equal(r.listeners.size, 1);
  r.leave(A.userId, 0);
  assert.equal(r.listeners.size, 1);
  r.leave(A.userId, 0);
  assert.equal(r.listeners.size, 0);
});

test('người chưa vào nghe không bỏ phiếu bỏ qua được', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  assert.equal(r.skip(B.userId, 0).error, 'not_listener');
  assert.equal(new Room().skip(A.userId, 0).error, 'nothing_playing');
});

test('hết hàng chờ thì phòng im lặng', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  r.advance(5);
  assert.equal(r.current, null);
});

test('videoError: sai bài thì bỏ qua; một người nghe báo là chuyển', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  r.addTrack(vid(2), A, 0);
  assert.equal(r.videoError(vid(2).videoId, A.userId, 1).error, 'stale');
  assert.equal(r.videoError(vid(1).videoId, B.userId, 1).error, 'not_listener');
  assert.equal(r.videoError(vid(1).videoId, A.userId, 1).ok, true);
  assert.equal(r.current.videoId, vid(2).videoId);
});

test('videoError: một máy lỗi trong phòng 3 người không chuyển bài, quá nửa mới chuyển', () => {
  const r = roomWith(A, B, C);
  r.addTrack(vid(1), A, 0);
  r.addTrack(vid(2), A, 0);
  r.videoError(vid(1).videoId, A.userId, 1);
  r.videoError(vid(1).videoId, A.userId, 2);
  assert.equal(r.current.videoId, vid(1).videoId);
  r.videoError(vid(1).videoId, B.userId, 3);
  assert.equal(r.current.videoId, vid(2).videoId);
  assert.equal(r.errorVotes.size, 0);
});

test('videoError: máy lỗi rời phòng thì phiếu lỗi của nó mất', () => {
  const r = roomWith(A, B, C);
  r.addTrack(vid(1), A, 0);
  r.videoError(vid(1).videoId, A.userId, 1);
  r.leave(A.userId, 2);
  assert.equal(r.current.videoId, vid(1).videoId);
  assert.equal(r.errorVotes.size, 0);
});

test('viewFor không lộ userId và đánh dấu bài của tôi', () => {
  const r = roomWith(A, B);
  r.addTrack(vid(1), A, 0);
  const t = r.addTrack(vid(2), A, 0).track;
  r.vote(t.id, B.userId);
  const v = r.viewFor(B.userId);
  assert.equal(v.current.addedBy, 'An');
  assert.deepEqual(v.queue[0], {
    id: t.id, videoId: vid(2).videoId, source: 'yt', src: null, title: 'Bài 2', channel: 'Kênh', thumb: '',
    durationSec: 180, addedBy: 'An', note: '', mine: false, votes: 1, votedByMe: true,
  });
  assert.equal(r.viewFor(A.userId).queue[0].mine, true);
  assert.deepEqual(v.skip, { count: 0, needed: 2, votedByMe: false });
  assert.deepEqual(v.listeners.map(l => l.name).sort(), ['An', 'Bình']);
  assert.ok(!JSON.stringify(v).includes('user-aaaa'));
  assert.equal(new Room().viewFor(null).current, null);
});

test('tạm dừng giữ đúng vị trí, phát tiếp chạy từ đó', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  r.pause('An', 30_000);
  assert.deepEqual(r.current.paused, { atSec: 30, byName: 'An', since: 30_000 });
  assert.equal(r.positionSec(90_000), 30);
  r.resume(90_000);
  assert.equal(r.current.paused, null);
  assert.equal(r.positionSec(100_000), 40);
});

test('tạm dừng hai lần không đổi vị trí; phát tiếp khi đang phát thì bỏ qua', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  r.pause('An', 10_000);
  r.pause('Bình', 50_000);
  assert.deepEqual(r.current.paused, { atSec: 10, byName: 'An', since: 10_000 });
  r.resume(60_000);
  r.resume(70_000);
  assert.equal(r.positionSec(70_000), 20);
  assert.equal(new Room().pause('An', 0).error, 'nothing_playing');
});

test('hẹn giờ: hết bài + 2 giây thì chuyển bài', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  r.addTrack(vid(2), A, 0);
  assert.equal(r.nextDeadline(), 182_000);
  assert.equal(r.tick(181_999), false);
  assert.equal(r.tick(182_000), true);
  assert.equal(r.current.videoId, vid(2).videoId);
  assert.equal(r.current.startedAt, 182_000);
  assert.equal(new Room().nextDeadline(), null);
});

test('đang dừng thì không hết bài; quá 30 phút tự phát tiếp', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  r.pause('An', 10_000);
  assert.equal(r.nextDeadline(), 10_000 + 30 * 60_000);
  assert.equal(r.tick(500_000), false);
  assert.equal(r.tick(10_000 + 30 * 60_000), true);
  assert.equal(r.current.paused, null);
  assert.equal(r.positionSec(10_000 + 30 * 60_000), 10);
});

test('bỏ qua khi đang dừng thì bài mới phát luôn', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  r.addTrack(vid(2), A, 0);
  r.pause('An', 5_000);
  r.skip(A.userId, 6_000);
  assert.equal(r.current.videoId, vid(2).videoId);
  assert.equal(r.current.paused, null);
  assert.equal(r.current.startedAt, 6_000);
});

test('lưu rồi khôi phục: hàng chờ, phiếu 👍, đang dừng vẫn dừng đúng chỗ', () => {
  const r = roomWith(A, B);
  r.addTrack(vid(1), A, 0);
  const t = r.addTrack(vid(2), A, 0).track;
  r.vote(t.id, B.userId);
  r.pause('An', 30_000);
  const data = JSON.parse(JSON.stringify(r.toJSON()));
  const back = Room.fromJSON(data, {}, 5_000_000);
  assert.equal(back.current.paused.atSec, 30);
  assert.equal(back.current.paused.since, 5_000_000);
  assert.equal(back.queue[0].votes.has(B.userId), true);
  assert.equal(back.seq, 2);
  assert.equal(back.listeners.size, 0);
  assert.equal(back.addTrack(vid(3), A, 1).track.id, 't3');
});

test('khôi phục khi bài đã quá giờ thì chuyển bài', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  r.addTrack(vid(2), A, 0);
  const back = Room.fromJSON(JSON.parse(JSON.stringify(r.toJSON())), {}, 999_000);
  assert.equal(back.current.videoId, vid(2).videoId);
  assert.equal(back.current.startedAt, 999_000);
});

test('khôi phục từ dữ liệu sai thì ném lỗi', () => {
  assert.throws(() => Room.fromJSON(null, {}, 0));
  assert.throws(() => Room.fromJSON({ v: 1, seq: 0, queue: [{ title: 'x' }] }, {}, 0));
  assert.throws(() => Room.fromJSON({ v: 2, seq: 0, queue: [] }, {}, 0));
});

// ---------- đợt tính năng 2 ----------
test('lịch sử: bài mới nhất lên đầu, không trùng, cộng dồn 👍', () => {
  const r = roomWith(A, B);
  r.addTrack(vid(1), A, 0);
  const t = r.addTrack(vid(2), A, 0).track;
  r.vote(t.id, B.userId);
  r.advance(10);
  assert.deepEqual(r.history.map(h => h.title), ['Bài 2', 'Bài 1']);
  assert.equal(r.history[0].likes, 1);
  r.addTrack(vid(2), B, 20);
  r.advance(30);
  assert.equal(r.history.filter(h => h.videoId === vid(2).videoId).length, 1);
});

test('tự phát khi hàng chờ trống: chọn từ lịch sử, tránh 10 bài vừa phát, nhường bài người chọn', () => {
  const r = new Room({ random: () => 0 });
  // lịch sử 12 bài, mới nhất trước: bài 12 … bài 1
  r.history = Array.from({ length: 12 }, (_, i) => ({ ...vid(12 - i), addedBy: 'An', likes: 0, playedAt: 0 }));
  r.join(A.userId, A.name, 0);
  // vừa vào phòng mà phòng im lặng → tự phát một bài không nằm trong 10 bài gần nhất (bài 1 hoặc 2)
  assert.equal(r.current.addedBy.userId, 'auto');
  assert.ok([vid(1).videoId, vid(2).videoId].includes(r.current.videoId));
  r.addTrack(vid(50), B, 99_000);
  assert.equal(r.current.videoId, vid(50).videoId);
  r.setAutoFill(false, 0);
  r.advance(100_000);
  assert.equal(r.current, null);
});

test('không ai nghe thì không tự phát', () => {
  const r = roomWith(A);
  for (let i = 1; i <= 12; i++) { r.addTrack(vid(i), A, i); r.advance(i); }
  r.leave(A.userId, 0);
  r.advance(1);
  assert.equal(r.current, null);
});

test('chủ phòng: khoá thêm bài, xoá bài người khác, chuyển bài ngay, không giới hạn 5 bài', () => {
  const r = roomWith(A, B);
  r.addTrack(vid(1), A, 0);
  const t = r.addTrack(vid(2), A, 0).track;
  r.setLocked(true);
  assert.equal(r.addTrack(vid(3), B, 0).error, 'locked');
  assert.equal(r.addTrack(vid(3), { ...B, admin: true }, 0).ok, true);
  assert.equal(r.remove(t.id, B.userId, true).ok, true);
  r.forceSkip(5);
  assert.equal(r.current.videoId, vid(3).videoId);
  r.setLocked(false);
  for (let i = 10; i < 17; i++) assert.equal(r.addTrack(vid(i), { ...B, admin: true }, i).ok, true);
});

test('giờ yên lặng: kiểm dữ liệu cấu hình', () => {
  const r = new Room();
  assert.equal(r.setQuiet({ enabled: true, days: [1, 2], ranges: [['09:00', '11:00']] }).ok, true);
  assert.deepEqual(r.quiet.ranges, [['09:00', '11:00']]);
  assert.equal(r.setQuiet({ enabled: true, days: [1], ranges: [['11:00', '09:00']] }).ok, false);
  assert.equal(r.setQuiet({ enabled: true, days: [1], ranges: [['25:00', '26:00']] }).ok, false);
});

test('chat giữ 100 tin gần nhất, cắt 300 ký tự, bỏ tin rỗng', () => {
  const r = new Room();
  assert.equal(r.addChat('An', '   ', 0).ok, false);
  for (let i = 0; i < 105; i++) r.addChat('An', 'x'.repeat(400), i);
  assert.equal(r.chat.length, 100);
  assert.equal(r.chat[0].text.length, 300);
});

test('bảng xếp hạng tuần: theo 👍 rồi lượt phát, bài tự phát không tính', () => {
  const r = new Room({ random: () => 0 });
  r.join(A.userId, 'An', 0); r.join(B.userId, 'Bình', 0);
  const now = new Date(2026, 9, 5, 10).getTime();
  r.addTrack(vid(1), A, now);
  const t2 = r.addTrack(vid(2), B, now).track;
  r.vote(t2.id, A.userId);
  r.advance(now + 1);
  const lb = r.leaderboard(now + 2);
  assert.equal(lb.week, '2026-W41');
  assert.deepEqual(lb.people[0], { name: 'Bình', plays: 1, likes: 1 });
  assert.equal(lb.tracks[0].title, 'Bài 2');
  assert.ok(!lb.people.some(p => p.name === 'Tự phát'));
});

test('lưu/khôi phục giữ lịch sử, chat, khoá, giờ yên lặng', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  r.addChat('An', 'chào', 1);
  r.setLocked(true);
  r.setQuiet({ enabled: false, days: [1], ranges: [['09:00', '10:00']] });
  const back = Room.fromJSON(JSON.parse(JSON.stringify(r.toJSON())), {}, 5);
  assert.equal(back.history.length, 1);
  assert.equal(back.chat[0].text, 'chào');
  assert.equal(back.locked, true);
  assert.equal(back.quiet.enabled, false);
});

test('tặng bài: lời nhắn đi theo bài vào hàng chờ, bài đang phát và lịch sử', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0, '  Tặng team kế toán 🎂  ');
  assert.equal(r.viewFor(A.userId).current.note, 'Tặng team kế toán 🎂');
  r.addTrack(vid(2), A, 0, 'x'.repeat(150));
  assert.equal(r.viewFor(A.userId).queue[0].note.length, 100);
  assert.equal(r.history[0].note, 'Tặng team kế toán 🎂');
});

test('chủ đề + phát ngay khi chúc mừng', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  r.addTrack(vid(2), A, 0);
  r.setTheme('  Thứ 6 sôi động 🔥 ');
  assert.equal(r.viewFor(null).theme, 'Thứ 6 sôi động 🔥');
  r.playNow(vid(2), { ...A, admin: true }, 50, 'Chúc mừng sinh nhật chị Lan');
  assert.equal(r.current.videoId, vid(2).videoId);
  assert.equal(r.queue.length, 0);
  assert.equal(r.current.note, 'Chúc mừng sinh nhật chị Lan');
  const back = Room.fromJSON(JSON.parse(JSON.stringify(r.toJSON())), {}, 60);
  assert.equal(back.theme, 'Thứ 6 sôi động 🔥');
});

test('ảnh đại diện đi theo người nghe và tin chat', () => {
  const r = new Room();
  r.join(A.userId, 'An', 0, '🐱');
  assert.deepEqual(r.viewFor(null).listeners, [{ name: 'An', avatar: '🐱' }]);
  r.addChat('An', 'hi', 1, '🐱');
  assert.equal(r.chat[0].avatar, '🐱');
});

test('thống kê cá nhân: tuần này, cộng dồn và hạng', () => {
  const r = new Room();
  r.join(A.userId, 'An', 0); r.join(B.userId, 'Bình', 0);
  const now = new Date(2026, 9, 5, 10).getTime();
  r.addTrack(vid(1), A, now);
  const t = r.addTrack(vid(2), A, now).track;
  r.vote(t.id, B.userId);
  r.advance(now + 1);
  r.stats['2026-W40'] = { people: { An: { plays: 3, likes: 2 } }, tracks: {} };
  const s = r.myStats('An', now + 2);
  assert.deepEqual(s.week, { plays: 2, likes: 1 });
  assert.deepEqual(s.all, { plays: 5, likes: 3 });
  assert.equal(s.rank, 1);
  assert.equal(r.myStats('Ai đó', now).rank, null);
});
