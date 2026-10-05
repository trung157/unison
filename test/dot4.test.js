import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';

const A = { userId: 'user-aaaa', name: 'An' };
const B = { userId: 'user-bbbb', name: 'Bình' };
const vid = n => ({
  videoId: `vid${String(n).padStart(8, '0')}`, title: `Bài ${n}`, channel: 'Kênh',
  thumb: '', durationSec: 180, embeddable: true,
});
function roomWith(...users) {
  const r = new Room();
  for (const u of users) r.join(u.userId, u.name);
  return r;
}

test('thả cảm xúc vào tin chat: bấm lại là bỏ', () => {
  const r = roomWith(A, B);
  const { msg } = r.addChat('An', 'chào', 1);
  r.reactChat(msg.id, 'Bình', '😂');
  r.reactChat(msg.id, 'An', '😂');
  assert.deepEqual(r.chat[0].reacts['😂'], ['Bình', 'An']);
  r.reactChat(msg.id, 'Bình', '😂');
  r.reactChat(msg.id, 'An', '😂');
  assert.equal(r.chat[0].reacts['😂'], undefined);
  assert.equal(r.reactChat(msg.id, 'An', '💩').ok, false);
});

test('lưu hàng chờ thành playlist, nạp lại vượt giới hạn 5 bài/người', () => {
  const r = roomWith(A, B);
  for (let i = 1; i <= 7; i++) r.addTrack(vid(i), { ...A, admin: true }, i);
  assert.equal(r.saveQueueAsPlaylist('Sáng thứ Hai', A).ok, true);
  assert.equal(r.playlists[0].tracks.length, 7);
  assert.equal(r.saveQueueAsPlaylist('sáng thứ hai', B).error, 'playlist_taken');
  const r2 = Room.fromJSON(JSON.parse(JSON.stringify(r.toJSON())), {}, 100);
  r2.join(B.userId, B.name);
  r2.current = null; r2.queue = [];
  const out = r2.enqueuePlaylist(r2.playlists[0].id, B, 200);
  assert.equal(out.added, 7);
  assert.equal(r2.queue.length, 6);
  assert.equal(r2.deletePlaylist(r2.playlists[0].id, B).error, 'not_owner');
  assert.equal(r2.deletePlaylist(r2.playlists[0].id, A).ok, true);
});

test('hẹn giờ chạy đúng một lần trong ngày, đúng thứ', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  const mon = new Date(2026, 9, 5, 15, 0, 30).getTime(); // thứ Hai 05/10/2026
  assert.equal(r.addSchedule({ time: '15:00', days: [1], label: 'Giãn cơ', kind: 'video', info: vid(9) }).ok, true);
  assert.equal(r.dueSchedules(mon - 60_000).length, 0);
  const due = r.dueSchedules(mon);
  assert.equal(due.length, 1);
  assert.equal(r.runSchedule(due[0], mon).ok, true);
  assert.equal(r.current.videoId, vid(9).videoId);
  assert.equal(r.dueSchedules(mon + 30_000).length, 0);
  assert.equal(r.dueSchedules(mon + 86_400_000).length, 0); // thứ Ba không có
  assert.equal(r.addSchedule({ time: '25:00', days: [1], kind: 'video', info: vid(9) }).ok, false);
});

test('tổng kết tuần cộng giờ nghe và chọn bài/người đứng đầu', () => {
  const r = roomWith(A, B);
  const t = new Date(2026, 9, 9, 10).getTime();
  r.addTrack(vid(1), A, t);
  r.addTrack(vid(2), B, t);
  r.vote(r.queue[0].id, A.userId);
  r.advance(t + 1);
  const s = r.weekSummary(t);
  assert.equal(s.plays, 2);
  assert.equal(s.sec, 360);
  assert.equal(s.topPerson.name, 'Bình');
  assert.equal(s.topTrack.title, 'Bài 2');
});

test('hàng chờ xếp lượt xen kẽ, người đang có bài phát lùi một vòng', () => {
  const r = roomWith(A, B);
  r.addTrack(vid(0), A, 0);                 // A đang phát
  const a1 = r.addTrack(vid(1), A, 1).track;
  const a2 = r.addTrack(vid(2), A, 2).track;
  const b1 = r.addTrack(vid(3), B, 3).track;
  const b2 = r.addTrack(vid(4), B, 4).track;
  assert.deepEqual(r.sortedQueue().map(t => t.id), [b1.id, a1.id, b2.id, a2.id]);
  r.vote(b2.id, A.userId);                  // 👍 chỉ đổi thứ tự trong lượt của B
  assert.deepEqual(r.sortedQueue().map(t => t.id), [b2.id, a1.id, b1.id, a2.id]);
});

test('bình chọn: mỗi người một phiếu, đổi được, bấm lại là rút', () => {
  const r = roomWith(A, B);
  assert.equal(r.startPoll('Nghe gì?', ['Ballad', 'EDM'], 'An').ok, true);
  r.votePoll(0, A.userId);
  r.votePoll(1, B.userId);
  r.votePoll(1, A.userId);
  let v = r.viewFor(A.userId).poll;
  assert.deepEqual(v.options.map(o => o.count), [0, 2]);
  assert.equal(v.myVote, 1);
  r.votePoll(1, A.userId);
  assert.equal(r.viewFor(A.userId).poll.myVote, -1);
  r.endPoll();
  assert.equal(r.votePoll(0, A.userId).error, 'no_poll');
  r.endPoll();
  assert.equal(r.poll, null);
  assert.equal(r.startPoll('?', ['một'], 'An').error, 'bad_poll');
});

test('chặn tạm: xoá bài đang chờ của người đó, hết giờ tự gỡ; xoá được tin chat', () => {
  const r = roomWith(A, B);
  r.addTrack(vid(1), A, 0);
  r.addTrack(vid(2), B, 0);
  assert.equal(r.block(B.userId, 60, 1000).ok, true);
  assert.equal(r.queue.length, 0);
  assert.ok(r.blockedUntil(B.userId, 2000) > 0);
  assert.equal(r.blockedUntil(B.userId, 1000 + 3_600_001), 0);
  const { msg } = r.addChat('Bình', 'spam', 1);
  assert.equal(r.deleteChat(msg.id).ok, true);
  assert.equal(r.chat.length, 0);
});

test('tự phát từ playlist khi hàng chờ trống', () => {
  const r = roomWith(A);
  r.addTrack(vid(1), A, 0);
  r.addTrack(vid(2), A, 0);
  r.saveQueueAsPlaylist('Lofi', A);
  const id = r.playlists[0].id;
  r.addTrack(vid(3), A, 0);
  r.current = null; r.queue = [];
  r.history = [];
  assert.equal(r.setFillPlaylist(id, 10).ok, true);
  assert.ok([vid(1).videoId, vid(2).videoId].includes(r.current.videoId));
  assert.equal(r.setFillPlaylist('p999', 10).error, 'not_found');
});

test('sinh nhật: kiểm ngày hợp lệ, chúc đúng một lần trong ngày', () => {
  const r = roomWith(A, B);
  assert.equal(r.setBirthday(A.userId, 'An', '02-30').error, 'bad_birthday');
  assert.equal(r.setBirthday(A.userId, 'An', '10-05').ok, true);
  const t = new Date(2026, 9, 5, 9).getTime();
  assert.deepEqual(r.dueBirthdays(t), ['An']);
  assert.deepEqual(r.dueBirthdays(t + 60_000), []);
  assert.deepEqual(r.dueBirthdays(new Date(2027, 9, 5, 9).getTime()), ['An']);
  assert.equal(r.badges(t)['An'].some(b => b.e === '🎂'), true);
});

test('huy hiệu: chăm chỉ 5 ngày làm liền (bỏ qua Chủ nhật), DJ của tuần', () => {
  const r = new Room();
  // T3 29/09 → T7 03/10, CN 04/10 nghỉ, T2 05/10
  for (const d of [29, 30]) r.join(A.userId, 'An', new Date(2026, 8, d, 9).getTime());
  for (const d of [1, 2, 3, 5]) r.join(A.userId, 'An', new Date(2026, 9, d, 9).getTime());
  const t = new Date(2026, 9, 5, 10).getTime();
  assert.equal(r.badges(t)['An'].some(b => b.e === '🔥'), true);
  r.join(B.userId, 'Bình', t);
  r.addTrack(vid(1), B, t);
  r.addTrack(vid(2), A, t);
  r.vote(r.queue[0].id, B.userId);
  r.advance(t + 1);
  assert.equal(r.badges(t)['An'].some(b => b.e === '🏆'), true);
});
