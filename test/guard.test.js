import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, clientIp } from '../server/guard.js';

test('khoá sau 5 lần sai, mở lại sau 15 phút; nhập đúng thì xoá đếm', () => {
  let t = 0;
  const g = createGuard({ now: () => t });
  for (let i = 0; i < 4; i++) g.fail('ip');
  assert.equal(g.lockedFor('ip'), 0);
  g.ok('ip');
  for (let i = 0; i < 4; i++) g.fail('ip');
  assert.equal(g.lockedFor('ip'), 0);           // đã xoá đếm nhờ ok()
  g.fail('ip');
  assert.equal(g.lockedFor('ip'), 15 * 60_000);
  t += 15 * 60_000;
  assert.equal(g.lockedFor('ip'), 0);
});

test('sai rải rác quá 10 phút thì không bị khoá', () => {
  let t = 0;
  const g = createGuard({ now: () => t });
  for (let i = 0; i < 10; i++) { g.fail('ip'); t += 3 * 60_000; }
  assert.equal(g.lockedFor('ip'), 0);
});

test('chỉ tin header proxy khi được cấu hình', () => {
  const req = { headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8, 9.9.9.9' }, address: '::ffff:10.0.0.1' };
  assert.equal(clientIp(req, ''), '10.0.0.1');
  assert.equal(clientIp(req, 'cloudflare'), '1.2.3.4');
  assert.equal(clientIp(req, 'proxy'), '5.6.7.8');
});
