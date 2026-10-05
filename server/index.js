// Khởi động Unison: đọc .env, khôi phục phòng, mở cổng, in địa chỉ trong mạng nội bộ.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room } from './room.js';
import { createYouTube } from './youtube.js';
import { createStore } from './store.js';
import { createApp } from './app.js';
import { createLibrary } from './library.js';
import { createLyrics } from './lyrics.js';
import { createBackup } from './backup.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* chưa có .env */ }

const PORT = Number(process.env.PORT) || 3456;
const cfg = {
  maxDurationMin: Number(process.env.MAX_DURATION_MIN) || 15,
  maxPerUser: Number(process.env.MAX_PER_USER) || 5,
  autoResumeMin: Number(process.env.AUTO_RESUME_MIN) || 30,
};

const store = createStore(path.join(ROOT, 'data', 'state.json'));
let room;
try {
  const saved = store.load();
  room = saved ? Room.fromJSON(saved, cfg, Date.now()) : new Room(cfg);
} catch (e) {
  console.warn('[unison]', e.message);
  store.quarantine();
  room = new Room(cfg);
}

if (!process.env.YT_API_KEY) {
  console.warn('[unison] Chưa có YT_API_KEY trong .env — tìm kiếm và thêm bài sẽ không chạy.');
}

if (!process.env.ROOM_CODE) {
  console.warn('[unison] Chưa có ROOM_CODE trong .env — ai có link cũng vào được.');
}

const library = createLibrary(path.join(ROOT, 'data'));
// Sao lưu mỗi ngày (mặc định thư mục backups/ cạnh dự án), giữ 14 ngày; kiểm mỗi giờ.
const backup = createBackup({
  files: [path.join(ROOT, 'data', 'state.json'), library.indexFile],
  dir: process.env.BACKUP_DIR || path.join(ROOT, 'backups'),
  keep: 14,
  beforeCopy: () => store.flush(),
});
const runBackup = () => { if (backup.runIfDue()) console.log('[unison] đã sao lưu', backup.status().last); };
setTimeout(runBackup, 10_000);
setInterval(runBackup, 3_600_000).unref();

const app = createApp({
  room,
  yt: createYouTube({ apiKey: process.env.YT_API_KEY }),
  store,
  backup,
  library,
  lyrics: createLyrics(),
  roomCode: process.env.ROOM_CODE ?? '',
  adminCode: process.env.ADMIN_CODE ?? '',
  appName: process.env.APP_NAME || 'Unison',
});
await app.listen(PORT, '0.0.0.0');

console.log(`[unison] Đang chạy ở cổng ${PORT}. Đồng nghiệp mở một trong các địa chỉ:`);
for (const list of Object.values(os.networkInterfaces())) {
  for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${PORT}`);
}

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
