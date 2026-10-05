// Lưu trạng thái phòng ra JSON: gộp lần ghi, ghi tệp tạm rồi đổi tên để không hỏng khi mất điện.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(file, { delayMs = 500 } = {}) {
  let timer = null;
  let pending = null;

  function writeNow(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  const store = {
    load() {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
      try {
        return JSON.parse(text);
      } catch {
        store.quarantine();
        return null;
      }
    },
    quarantine() {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(path.dirname(file), `state.hong-${stamp}.json`);
      try {
        fs.renameSync(file, dest);
        console.warn(`[unison] state.json hỏng, đã cất thành ${dest}`);
      } catch { /* không có tệp để cất */ }
    },
    save(data) {
      pending = data;
      if (!timer) timer = setTimeout(() => store.flush(), delayMs);
    },
    flush() {
      clearTimeout(timer);
      timer = null;
      if (!pending) return;
      const data = pending;
      pending = null;
      writeNow(data);
    },
  };
  return store;
}
