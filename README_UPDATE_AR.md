# تقرير تحديث OrbitPress Scraper API

هذا التحديث يرفع الخدمة إلى النسخة **1.1.0**: أقسى أماناً، أثبت في الأخطاء، وأعمق في جمع النتائج — مع الحفاظ الكامل على العقد (schema) المتوقعة من تطبيق OrbitPress (`x-orbitpress-key`, HTTPS, `posts[]`, `pins[]`).

## 🔐 الأمان

- **فحص قوة المفتاح**: إذا كان `ORBITPRESS_API_KEY` مفقوداً أو أقصر من 32 حرفاً ترفض الخدمة الطلبات بـ `500 Server is misconfigured` (بدلاً من العمل بمفتاح ضعيف بصمت). قابل للضبط عبر `MIN_API_KEY_LENGTH`.
- **مقارنة المفتاح بتوقيت ثابت** عبر `crypto.timingSafeEqual` لمنع هجمات التوقيت (timing attacks).
- **Rate limiting لكل عنوان IP**: افتراضياً 60 طلباً/دقيقة (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`)، ويُطبّق على `/health` وكل مسارات `/api/*`.
- **إخفاء تفاصيل الأخطاء**: رسائل عامة للعميل (`Facebook extraction failed`) بدون `detail`؛ التفاصيل الحقيقية تُكتب في سجل الخادم فقط، ولا تظهر في الاستجابة إلا بضبط `EXPOSE_ERROR_DETAILS=true` للتشخيص.
- **Cookies المستوردة**: تُحقّق من `domain` لكل منصة وتُخزَّن بـ `secure: true`، وتُحقن في الـ context بـ `secure: true` أيضاً — مع بقاء شرط HTTPS للاستيراد كما هو.

## 🧱 الثبات والاختبارات

- ملف جديد `src/contracts.js`: دوال صافية بدون dependencies لتطبيع النتائج والترقيم.
- ملف جديد `test/contracts.test.js`: **7 اختبارات** بواسطة `node --test` — `parseCount`، ترميز/فك الـ cursor، أولوية الـ cursor على offset، حالات `hasMore/nextCursor`، عقد Facebook، عقد Pinterest و`viralScore`.
- **CI حقيقي** في `.github/workflows/ci.yml`: `npm ci` ← `node --check` لكل من `src/server.js` و`src/contracts.js` ← `npm test` (بدلاً من فحص الصياغة فقط).
- **مهلة لكل مهمة سحب**: `JOB_TIMEOUT_MS=90000` (افتراضي 90 ثانية) تلفّ مهام Facebook وPinterest وفحص الجلسات، فلا تبقى مهمة معلّقة تحجز خانة من `MAX_CONCURRENT_JOBS` إلى الأبد.

## 🚀 كفاءة السحب

- **Pagination كامل**: تقبل الطلبات `offset` و/أو `cursor` (معتم base64 يتقدّم على offset)، وترجع الاستجابة كتلة:
  ```json
  "pagination": { "limit": 20, "offset": 0, "count": 20, "totalCollected": 45,
                  "hasMore": true, "nextCursor": "eyJvIjoyMH0", "cursorApplied": false }
  ```
  أرسل `nextCursor` في الطلب التالي لجلب الصفحة التالية حتى يصبح `hasMore=false`.
- **Facebook**: حتى **36 جولة تمرير** (بدلاً من 30) لجمع `offset + maxPosts` عنصراً، مع إيقاف مبكر عند ركود 6 جولات (`exhausted`)، والـ fallback لنسخة `m.facebook.com` كما هو.
- **Pinterest**: حتى **14 جولة تمرير** (بدلاً من 10) مع كشف الركود، ومحاولة قراءة saves/comments/shares من نص البطاقة، ثم **إثراء** أعلى الـ pins بدرجة `viralScore` (حتى `PINTEREST_ENRICH_LIMIT=5` افتراضياً) بفتح صفحة الـ pin وقراءة `og:*` وJSON-LD (العنوان، الوصف، الصورة، `datePublished`، `commentCount`) — بشكل best-effort لا يُسقط الطلب عند الفشل.

## 📦 مطابقة التطبيق

- **Facebook `posts[]`**: كل عنصر يضمن الحقول `kind`, `isComment`, `author`, `text`, `url`, `likes`, `comments`, `shares`, `reactions` (قيم رقمية افتراضية 0 بدلاً من غياب الحقول)، و`publishedAt` عند توفره.
- **Pinterest `pins[]`**: كل عنصر يضمن `url`, `title`, `text`, `description`, `imageUrl`, `saves`, `comments`, `shares`, `publishedAt`, `viralScore` — و`viralScore` = `saves×4 + comments×3 + shares×6`.
- مسارات الجلسات `/api/session/status`, `/api/session/:platform/check`, `/api/session/:platform/import` ومسارا السحب كما هي تماماً بالنسبة للعميل، والمصادقة بـ `x-orbitpress-key` وشرط HTTPS محفوظان.

## ⚙️ متغيرات بيئة جديدة

| المتغير | الافتراضي | الوظيفة |
|---|---|---|
| `MIN_API_KEY_LENGTH` | `32` | الحد الأدنى لطول مفتاح API |
| `JOB_TIMEOUT_MS` | `90000` | مهلة مهمة السحب الواحدة |
| `RATE_LIMIT_MAX` | `60` | أقصى عدد طلبات لكل IP ضمن النافذة |
| `RATE_LIMIT_WINDOW_MS` | `60000` | طول نافذة الـ rate limit |
| `EXPOSE_ERROR_DETAILS` | `false` | إظهار تفاصيل الأخطاء (للتشخيص فقط) |
| `PINTEREST_ENRICH_LIMIT` | `5` | عدد الـ pins المُثرة بفتح صفحاتها (0 = تعطيل) |

## ✅ التحقق المحلي

- `node --check src/server.js` و`node --check src/contracts.js` — سليمان.
- `node --test` — **7/7 ناجحة**.
- فحص تشغيلي يدوي: `/health` يعمل، غياب/خطأ المفتاح → `401`، مفتاح أقصر من 32 → `500`، تجاوز الـ rate limit → `429`، والرسائل العامة لا تسرّب تفاصيل داخلية.
