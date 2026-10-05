import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOpen } from '../server/quiet.js';
import { cleanTitle, createLyrics } from '../server/lyrics.js';
import { createLibrary, fold, looksLikeMp3 } from '../server/library.js';
import { parsePlaylistId, createYouTube } from '../server/youtube.js';
import { DEFAULT_QUIET } from '../server/room.js';

test('giờ yên lặng: chỉ phát 8:00–12:00 và 13:00–17:30 từ thứ 2 tới thứ 7', () => {
  const at = (day, h, m) => new Date(2026, 9, 4 + day, h, m); // 4/10/2026 là Chủ nhật
  assert.equal(isOpen(at(1, 8, 0), DEFAULT_QUIET), true);
  assert.equal(isOpen(at(1, 7, 59), DEFAULT_QUIET), false);
  assert.equal(isOpen(at(1, 12, 0), DEFAULT_QUIET), false);
  assert.equal(isOpen(at(1, 13, 0), DEFAULT_QUIET), true);
  assert.equal(isOpen(at(1, 12, 59), DEFAULT_QUIET), false);
  assert.equal(isOpen(at(6, 17, 29), DEFAULT_QUIET), true);
  assert.equal(isOpen(at(6, 17, 30), DEFAULT_QUIET), false);
  assert.equal(isOpen(at(0, 10, 0), DEFAULT_QUIET), false);
  assert.equal(isOpen(at(0, 10, 0), { ...DEFAULT_QUIET, enabled: false }), true);
});

test('cleanTitle bỏ phần thừa của tên video', () => {
  assert.equal(cleanTitle('LẠC TRÔI | OFFICIAL MUSIC VIDEO | SƠN TÙNG M-TP'), 'LẠC TRÔI');
  assert.equal(cleanTitle('Hãy Trao Cho Anh (Official MV) ft. Snoop Dogg'), 'Hãy Trao Cho Anh');
  assert.equal(cleanTitle('Song [Lyrics] #nhachay'), 'Song');
});

test('lời bài: chọn bản khớp thời lượng và có lời chạy theo giây, có bộ nhớ đệm', async () => {
  const calls = [];
  const fetchFn = async url => {
    calls.push(url);
    return { ok: true, json: async () => [
      { duration: 100, plainLyrics: 'sai bài' },
      { duration: 272, plainLyrics: 'lời thường' },
      { duration: 274, syncedLyrics: '[00:01.00] dòng 1', plainLyrics: 'dòng 1' },
    ] };
  };
  const ly = createLyrics({ fetchFn });
  const track = { videoId: 'x', title: 'Lạc Trôi (Official MV)', durationSec: 273 };
  const v = await ly.get(track);
  assert.equal(v.synced, '[00:01.00] dòng 1');
  assert.match(calls[0], /q=L%E1%BA%A1c\+Tr%C3%B4i/);
  await ly.get(track);
  assert.equal(calls.length, 1);
});

test('kho mp3: nhận diện mp3, tìm không dấu, lưu và đọc lại danh mục', () => {
  assert.equal(looksLikeMp3(Buffer.from('ID3\x04\x00abc')), true);
  assert.equal(looksLikeMp3(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00])), true);
  assert.equal(looksLikeMp3(Buffer.from('<html>')), false);
  assert.equal(fold('Lạc Trôi Đẹp'), 'lac troi dep');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unison-lib-'));
  const lib = createLibrary(dir);
  const info = lib.add({ buf: Buffer.from('ID3xxxx'), title: 'Lạc Trôi', durationSec: 200, uploadedBy: 'An', now: 0 });
  assert.match(info.videoId, /^file:/);
  assert.equal(info.source, 'file');
  assert.ok(fs.existsSync(path.join(dir, 'uploads', info.src.split('/').pop())));
  const again = createLibrary(dir);
  assert.equal(again.get(info.videoId).title, 'Lạc Trôi');
  assert.equal(again.search('lac troi').length, 1);
  assert.equal(again.totalBytes(), 7);
});

test('playlist: chỉ nhận link trang playlist, bỏ danh sách tự sinh', async () => {
  assert.equal(parsePlaylistId('https://www.youtube.com/playlist?list=PL1234567890abc'), 'PL1234567890abc');
  assert.equal(parsePlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890abc'), null);
  assert.equal(parsePlaylistId('https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ'), null);
  const fetchFn = async url => {
    const name = new URL(url).pathname.split('/').pop();
    const body = name === 'playlistItems'
      ? { items: [{ contentDetails: { videoId: 'aaaaaaaaaaa' } }] }
      : { items: [{ id: 'aaaaaaaaaaa', snippet: { title: 'A' }, contentDetails: { duration: 'PT3M' }, status: { embeddable: true } }] };
    return { ok: true, status: 200, json: async () => body };
  };
  const list = await createYouTube({ apiKey: 'k', fetchFn }).getPlaylist('PL1234567890abc');
  assert.deepEqual(list.map(v => v.videoId), ['aaaaaaaaaaa']);
});
