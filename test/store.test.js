import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unison-')), 'data', 'state.json');

test('chưa có tệp thì load trả null', () => {
  assert.equal(createStore(tmpFile()).load(), null);
});

test('save gộp lần ghi, flush ghi ngay, load đọc lại', () => {
  const file = tmpFile();
  const store = createStore(file, { delayMs: 60_000 });
  store.save({ a: 1 });
  store.save({ a: 2 });
  assert.equal(fs.existsSync(file), false);
  store.flush();
  assert.deepEqual(createStore(file).load(), { a: 2 });
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('tệp hỏng thì cất sang state.hong-*.json và trả null', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{hỏng');
  const store = createStore(file);
  const warn = console.warn;
  console.warn = () => {};
  try { assert.equal(store.load(), null); } finally { console.warn = warn; }
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.dirname(file)).filter(f => f.startsWith('state.hong-')).length, 1);
});
