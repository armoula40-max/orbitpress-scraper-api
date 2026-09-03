# OrbitPress Scraper API

خدمة Node.js/Playwright منفصلة لتزويد تطبيق OrbitPress بنتائج من **صفحات ومشاركات Facebook العامة** و**Board/Profile/Pin العامة في Pinterest**. لا تسجل دخولاً ولا تتجاوز CAPTCHA أو الحماية، ولا تحفظ Cookies.

## التشغيل عبر Docker

```bash
cp .env.example .env
# عدّل ORBITPRESS_API_KEY إلى قيمة طويلة عشوائية
openssl rand -hex 32
sudo docker compose up -d --build
curl http://127.0.0.1:8080/health
```

## API

الاستخراج يتم مباشرة على VPS بواسطة Playwright، ولا يعتمد على Apify أو وسيط استخراج خارجي. إذا أعاد Facebook نتائج فارغة بسبب الحجب أو تغيّر HTML، تُحدّث محددات Playwright في `src/server.js`.

أرسل مفتاح المصادقة في `x-orbitpress-key`.

```bash
curl -X POST http://127.0.0.1:8080/api/facebook/scrape \
  -H 'content-type: application/json' \
  -H 'x-orbitpress-key: YOUR_KEY' \
  -d '{"url":"https://www.facebook.com/public-page","maxPosts":10}'

curl -X POST http://127.0.0.1:8080/api/pinterest/scrape \
  -H 'content-type: application/json' \
  -H 'x-orbitpress-key: YOUR_KEY' \
  -d '{"url":"https://www.pinterest.com/example/board-name/","maxItems":20}'
```

## ملاحظات الإنتاج

اربط الخدمة خلف Nginx/Caddy مع HTTPS، ولا تفتح المنفذ 8080 للعامة مباشرة. ضع المفتاح في `.env` على VPS فقط. HTML selectors في مواقع التواصل قابلة للتغيير؛ لذلك يجب مراقبة الخدمة وتحديثها عند تغيّر الموقع. استخدم المحتوى العام فقط واحترم شروط Facebook وPinterest والقوانين المحلية.
