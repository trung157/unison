// Sao lưu dữ liệu phòng mỗi ngày một bản: chép state.json + library.json vào thư mục ngày, giữ N ngày gần nhất.
// Không chép file mp3 (có thể tới 5 GB) — chỉ danh mục.
import fs from 'node:fs';
import path from 'node:path';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function createBackup({ files, dir, keep = 14, now = Date.now, beforeCopy = () => {} }) {
  let last = null;
  let lastError = '';

  function list() {
    try { return fs.readdirSync(dir).filter(n => DAY_RE.test(n)).sort(); } catch { return []; }
  }

  // Chưa có bản hôm nay thì sao lưu; trả true nếu vừa sao lưu.
  function runIfDue() {
    const day = dayOf(now());
    if (list().includes(day)) { last ??= day; return false; }
    try {
      beforeCopy();
      const dest = path.join(dir, day);
      fs.mkdirSync(dest, { recursive: true });
      for (const f of files) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dest, path.basename(f)));
      for (const old of list().slice(0, -keep)) fs.rmSync(path.join(dir, old), { recursive: true, force: true });
      last = day;
      lastError = '';
      return true;
    } catch (e) {
      lastError = e.message;
      return false;
    }
  }

  return { runIfDue, status: () => ({ dir, last, count: list().length, keep, error: lastError }) };
}
