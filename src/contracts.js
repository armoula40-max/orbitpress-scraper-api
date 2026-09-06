/**
 * contracts.js — دوال صافية (بدون dependencies) لتطبيع نتائج السحب
 * وضمان ثبات العقد (schema) المتوقعة من تطبيق OrbitPress:
 *
 *   Facebook → posts[]: { kind, isComment, author, text, url, likes, comments, shares, reactions }
 *   Pinterest → pins[]: { url, title, text, description, imageUrl, saves, comments, shares, publishedAt, viralScore }
 *
 * وفورمات الترقيم (pagination): { limit, offset, count, totalCollected, hasMore, nextCursor, cursorApplied }
 */

const COUNT_SUFFIX_FACTORS = { K: 1e3, M: 1e6, B: 1e9 };

/** يحوّل نصاً مثل "1.2K" أو "3,400" إلى رقم، ويعيد null عند التعذّر. */
export function parseCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const match = String(value ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
  if (!match) return null;
  const factor = COUNT_SUFFIX_FACTORS[String(match[2] || '').toUpperCase()] || 1;
  return Math.round(Number(match[1]) * factor);
}

/** يثبّت حد النتائج ضمن مجال مقبول. */
export function clampLimit(value, { min = 1, max = 100, fallback = 20 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** يشفّر offset في cursor معتم (base64url) لاستخدامه في الطلب التالي. */
export function encodeCursor(offset) {
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  return Buffer.from(JSON.stringify({ o: safeOffset }), 'utf8').toString('base64url');
}

/** يفك cursor ويعيد offset، أو null إذا كان غير صالح. */
export function decodeCursor(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const offset = Number(parsed?.o);
    return Number.isFinite(offset) && offset >= 0 ? Math.trunc(offset) : null;
  } catch {
    return null;
  }
}

/**
 * يحسب offset الفعلي للطلب. الـ cursor الصالح يتقدّم على offset الخام،
 * وcursorApplied يخبر العميل أن الـ cursor طُبّق فعلاً.
 */
export function resolveOffset({ cursor, offset } = {}) {
  const fromCursor = decodeCursor(cursor);
  if (fromCursor != null) return { offset: fromCursor, cursorApplied: true };
  const raw = Math.trunc(Number(offset));
  return { offset: Number.isFinite(raw) && raw > 0 ? raw : 0, cursorApplied: false };
}

/**
 * يبني كتلة pagination للاستجابة.
 *   collected  — إجمالي العناصر التي جمعها السحب (قبل الاقتطاع).
 *   exhausted  — true إذا توقف التمرير بسبب الركود (لا مزيد من العناصر غالباً).
 */
export function buildPagination({ offset = 0, limit = 20, collected = 0, exhausted = true } = {}) {
  const count = Math.max(0, Math.min(limit, collected - offset));
  const hasMore = collected > offset + count || (!exhausted && collected > offset && count === limit && collected === offset + count);
  return {
    limit,
    offset,
    count,
    totalCollected: collected,
    hasMore,
    nextCursor: hasMore ? encodeCursor(offset + count) : null,
    cursorApplied: offset > 0
  };
}

function nonNegativeInt(value) {
  const parsed = parseCount(value);
  return parsed == null ? 0 : parsed;
}

/** درجة الانتشار لـ Pinterest: المشاركة أثقل، ثم الحفظ، ثم التعليق. */
export function computeViralScore({ saves = 0, comments = 0, shares = 0 } = {}) {
  return nonNegativeInt(saves) * 4 + nonNegativeInt(comments) * 3 + nonNegativeInt(shares) * 6;
}

/** يضمن ثبات عقد عنصر منشور Facebook مهما كانت مخرجات الاستخراج. */
export function normalizeFacebookPost(raw = {}) {
  const reactions = raw.reactions == null ? nonNegativeInt(raw.likes) : nonNegativeInt(raw.reactions);
  const post = {
    kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'facebook_post',
    isComment: Boolean(raw.isComment),
    author: String(raw.author || ''),
    text: String(raw.text || '').slice(0, 5000),
    url: String(raw.url || ''),
    likes: raw.likes == null ? reactions : nonNegativeInt(raw.likes),
    comments: nonNegativeInt(raw.comments),
    shares: nonNegativeInt(raw.shares),
    reactions
  };
  if (raw.publishedAt) post.publishedAt = String(raw.publishedAt);
  return post;
}

/** يضمن ثبات عقد عنصر Pin في Pinterest + حساب viralScore. */
export function normalizePinterestPin(raw = {}) {
  const title = String(raw.title || '').trim();
  const description = String(raw.description || '').trim();
  const saves = nonNegativeInt(raw.saves);
  const comments = nonNegativeInt(raw.comments);
  const shares = nonNegativeInt(raw.shares);
  const pin = {
    url: String(raw.url || ''),
    title,
    text: String(raw.text || title || description).slice(0, 5000),
    description,
    imageUrl: String(raw.imageUrl || raw.image || ''),
    saves,
    comments,
    shares,
    publishedAt: raw.publishedAt ? String(raw.publishedAt) : null,
    viralScore: computeViralScore({ saves, comments, shares })
  };
  return pin;
}
