import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVideoId, parseDuration, createYouTube } from '../server/youtube.js';

const ID = 'dQw4w9WgXcQ';

test('parseVideoId nhận các dạng link YouTube', () => {
  for (const s of [
    `https://www.youtube.com/watch?v=${ID}&t=10`, `https://youtu.be/${ID}?si=abc`,
    `https://m.youtube.com/watch?v=${ID}`, `https://youtube.com/shorts/${ID}`,
    `https://music.youtube.com/watch?v=${ID}&list=RD`, `https://www.youtube.com/embed/${ID}`,
    `  youtube.com/watch?v=${ID}  `,
  ]) assert.equal(parseVideoId(s), ID, s);
  for (const s of ['', 'sơn tùng', ID, 'https://example.com/watch?v=' + ID, 'https://youtu.be/ngan']) {
    assert.equal(parseVideoId(s), null, s);
  }
});

test('parseDuration đọc ISO 8601', () => {
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT45S'), 45);
  assert.equal(parseDuration('PT4M'), 240);
  assert.equal(parseDuration('P0D'), 0);
  assert.equal(parseDuration('P1DT1S'), 86401);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration(undefined), null);
});

function fakeFetch(routes) {
  const fn = async url => {
    fn.calls.push(url);
    const name = new URL(url).pathname.split('/').pop();
    const route = routes[name];
    const out = typeof route === 'function' ? route(new URL(url)) : route;
    if (out instanceof Error) throw out;
    const status = out.status ?? 200;
    return { ok: status < 400, status, json: async () => out.body };
  };
  fn.calls = [];
  return fn;
}
const item = (id, extra = {}) => ({
  id,
  snippet: { title: `Bài ${id}`, channelTitle: 'Kênh', thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } } },
  contentDetails: { duration: 'PT3M' },
  status: { embeddable: true },
  ...extra,
});

test('search giữ thứ tự, lọc video cấm nhúng/phát trực tiếp, có bộ nhớ đệm', async () => {
  const fetchFn = fakeFetch({
    search: { body: { items: [{ id: { videoId: 'aaaaaaaaaaa' } }, { id: { videoId: 'bbbbbbbbbbb' } }, { id: { videoId: 'ccccccccccc' } }] } },
    videos: { body: { items: [
      item('ccccccccccc'),
      item('aaaaaaaaaaa'),
      item('bbbbbbbbbbb', { status: { embeddable: false } }),
    ] } },
  });
  const yt = createYouTube({ apiKey: 'k', fetchFn });
  const res = await yt.search('  Lạc Trôi  ');
  assert.deepEqual(res.map(v => v.videoId), ['aaaaaaaaaaa', 'ccccccccccc']);
  assert.deepEqual(res[0], {
    videoId: 'aaaaaaaaaaa', title: 'Bài aaaaaaaaaaa', channel: 'Kênh',
    thumb: 'https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg', durationSec: 180, embeddable: true,
  });
  const searchUrl = new URL(fetchFn.calls[0]);
  assert.equal(searchUrl.searchParams.get('q'), 'lạc trôi');
  assert.equal(searchUrl.searchParams.get('regionCode'), 'VN');
  await yt.search('lạc   TRÔI');
  assert.equal(fetchFn.calls.length, 2);
  assert.equal((await yt.getVideo('aaaaaaaaaaa')).title, 'Bài aaaaaaaaaaa');
  assert.equal(fetchFn.calls.length, 2);
});

test('getVideo trả null khi không có video', async () => {
  const yt = createYouTube({ apiKey: 'k', fetchFn: fakeFetch({ videos: { body: { items: [] } } }) });
  assert.equal(await yt.getVideo('zzzzzzzzzzz'), null);
  assert.equal(await yt.getVideo('xau'), null);
});

test('hết hạn mức báo quota', async () => {
  const yt = createYouTube({ apiKey: 'k', fetchFn: fakeFetch({
    search: { status: 403, body: { error: { errors: [{ reason: 'quotaExceeded' }] } } },
  }) });
  await assert.rejects(yt.search('abc'), { code: 'quota' });
});

test('lỗi mạng thử lại 1 lần', async () => {
  let n = 0;
  const fetchFn = fakeFetch({ videos: () => (++n === 1 ? new Error('ECONNRESET') : { body: { items: [item(ID)] } }) });
  const yt = createYouTube({ apiKey: 'k', fetchFn });
  assert.equal((await yt.getVideo(ID)).videoId, ID);
  assert.equal(fetchFn.calls.length, 2);

  const always = fakeFetch({ videos: () => new Error('down') });
  await assert.rejects(createYouTube({ apiKey: 'k', fetchFn: always }).getVideo(ID), { code: 'network' });
  assert.equal(always.calls.length, 2);
});

test('thiếu API key thì báo no_key, không gọi mạng', async () => {
  const fetchFn = fakeFetch({});
  const yt = createYouTube({ apiKey: '', fetchFn });
  await assert.rejects(yt.search('abc'), { code: 'no_key' });
  await assert.rejects(yt.getVideo(ID), { code: 'no_key' });
  assert.equal(fetchFn.calls.length, 0);
});
