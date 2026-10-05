// Kho nhạc tải lên (mp3): tệp ở data/uploads/<id>.mp3, danh mục ở data/library.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;

// Bỏ dấu tiếng Việt để tìm "lac troi" ra "Lạc Trôi".
export const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();

// MP3 bắt đầu bằng thẻ ID3 hoặc khung MPEG (11 bit đầu đều là 1).
export const looksLikeMp3 = buf => buf.length > 4
  && ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));

export function createLibrary(dir) {
  const filesDir = path.join(dir, 'uploads');
  const indexFile = path.join(dir, 'library.json');
  fs.mkdirSync(filesDir, { recursive: true });
  let items = [];
  try { items = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { items = []; }

  const save = () => {
    fs.writeFileSync(indexFile + '.tmp', JSON.stringify(items, null, 2));
    fs.renameSync(indexFile + '.tmp', indexFile);
  };
  const info = it => ({
    videoId: `file:${it.id}`, source: 'file', src: `/files/${it.id}.mp3`, title: it.title,
    channel: `Tải lên bởi ${it.uploadedBy}`, thumb: '', durationSec: it.durationSec, embeddable: true,
  });

  return {
    filesDir,
    totalBytes: () => items.reduce((s, it) => s + it.size, 0),
    count: () => items.length,
    indexFile,
    add({ buf, title, durationSec, uploadedBy, now }) {
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(filesDir, `${id}.mp3`), buf);
      const it = { id, title, durationSec, size: buf.length, uploadedBy, at: now };
      items.push(it);
      save();
      return info(it);
    },
    get(videoId) {
      const it = items.find(x => `file:${x.id}` === videoId);
      return it ? info(it) : null;
    },
    search(q) {
      const f = fold(q);
      return items.filter(it => fold(it.title).includes(f)).slice(-10).reverse().map(info);
    },
  };
}
