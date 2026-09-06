import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPagination,
  clampLimit,
  computeViralScore,
  decodeCursor,
  encodeCursor,
  normalizeFacebookPost,
  normalizePinterestPin,
  parseCount,
  resolveOffset
} from '../src/contracts.js';

test('parseCount يحوّل صيغ K/M/B والفواصل إلى أرقام', () => {
  assert.equal(parseCount('1.2K'), 1200);
  assert.equal(parseCount('3,400'), 3400);
  assert.equal(parseCount('2M'), 2000000);
  assert.equal(parseCount('١٢'), null); // أرقام عربية غير مدعومة هنا
  assert.equal(parseCount('لا يوجد رقم'), null);
});

test('encodeCursor/decodeCursor رحلة ذهاب وعودة', () => {
  const cursor = encodeCursor(40);
  assert.equal(typeof cursor, 'string');
  assert.equal(decodeCursor(cursor), 40);
  assert.equal(decodeCursor('###not-base64###'), null);
  assert.equal(decodeCursor(''), null);
});

test('resolveOffset يفضّل الـ cursor الصالح على offset الخام', () => {
  const cursor = encodeCursor(25);
  assert.deepEqual(resolveOffset({ cursor, offset: 3 }), { offset: 25, cursorApplied: true });
  assert.deepEqual(resolveOffset({ offset: 7 }), { offset: 7, cursorApplied: false });
  assert.deepEqual(resolveOffset({ offset: -5 }), { offset: 0, cursorApplied: false });
  assert.deepEqual(resolveOffset({ cursor: 'broken', offset: 9 }), { offset: 9, cursorApplied: false });
});

test('buildPagination يعيد nextCursor عندما توجد نتائج إضافية', () => {
  const page = buildPagination({ offset: 0, limit: 10, collected: 25, exhausted: false });
  assert.equal(page.count, 10);
  assert.equal(page.hasMore, true);
  assert.equal(decodeCursor(page.nextCursor), 10);
  assert.equal(page.cursorApplied, false);
});

test('buildPagination يوقف الترقيم عند نهاية النتائج أو الركود', () => {
  const last = buildPagination({ offset: 20, limit: 10, collected: 25, exhausted: true });
  assert.equal(last.count, 5);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextCursor, null);
  assert.equal(last.cursorApplied, true);
  const beyondEnd = buildPagination({ offset: 50, limit: 10, collected: 25, exhausted: true });
  assert.equal(beyondEnd.count, 0);
  assert.equal(beyondEnd.hasMore, false);
});

test('normalizeFacebookPost يضمن عقد likes/comments/shares/reactions', () => {
  const post = normalizeFacebookPost({ text: 'مرحبا', url: 'https://www.facebook.com/x/posts/1', reactions: '1.5K' });
  assert.equal(post.kind, 'facebook_post');
  assert.equal(post.isComment, false);
  assert.equal(post.author, '');
  assert.equal(post.reactions, 1500);
  assert.equal(post.likes, 1500);
  assert.equal(post.comments, 0);
  assert.equal(post.shares, 0);
});

test('normalizePinterestPin يضمن العقد ويحسب viralScore', () => {
  const pin = normalizePinterestPin({ url: 'https://www.pinterest.com/pin/1/', title: 'وصفة', image: 'https://img/1.jpg', saves: 10, comments: 2, shares: 1 });
  assert.equal(pin.imageUrl, 'https://img/1.jpg');
  assert.equal(pin.text, 'وصفة');
  assert.equal(pin.publishedAt, null);
  assert.equal(pin.viralScore, 10 * 4 + 2 * 3 + 1 * 6);
  assert.equal(computeViralScore({}), 0);
  assert.equal(clampLimit(500, { min: 1, max: 100, fallback: 20 }), 100);
});
