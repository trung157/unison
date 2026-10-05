import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackup } from '../server/backup.js';

test('sao lưu mỗi ngày một bản, giữ đúng số ngày', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-bk-'));
  const src = path.join(tmp, 'state.json');
  fs.writeFileSync(src, '{"v":1}');
  let t = new Date(2026, 9, 1, 9).getTime();
  const b = createBackup({ files: [src, path.join(tmp, 'khong-co.json')], dir: path.join(tmp, 'bk'), keep: 3, now: () => t });
  assert.equal(b.runIfDue(), true);
  assert.equal(b.runIfDue(), false);
  for (let i = 0; i < 4; i++) { t += 86_400_000; b.runIfDue(); }
  const s = b.status();
  assert.equal(s.count, 3);
  assert.equal(s.last, '2026-10-05');
  assert.equal(fs.readFileSync(path.join(tmp, 'bk', '2026-10-05', 'state.json'), 'utf8'), '{"v":1}');
  assert.equal(fs.existsSync(path.join(tmp, 'bk', '2026-10-02')), false);
});
