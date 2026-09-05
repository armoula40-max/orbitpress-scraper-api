# جلسات Facebook وPinterest المحفوظة

الخدمة تدعم الآن ملف جلسة مستقل لكل منصة داخل:

- `./sessions/facebook`
- `./sessions/pinterest`

لا يتم رفع هذه الملفات إلى GitHub، وهي تحتوي على بيانات جلسة حساسة وتعادل تسجيل الدخول.

## فحص الجلسات

```bash
export ORBITPRESS_API_KEY=$(grep '^ORBITPRESS_API_KEY=' .env | cut -d= -f2-)
curl -s http://127.0.0.1:8080/api/session/status \
  -H "x-orbitpress-key: $ORBITPRESS_API_KEY"
```

وفحص منصة واحدة:

```bash
curl -s http://127.0.0.1:8080/api/session/facebook/check \
  -H "x-orbitpress-key: $ORBITPRESS_API_KEY"

curl -s http://127.0.0.1:8080/api/session/pinterest/check \
  -H "x-orbitpress-key: $ORBITPRESS_API_KEY"
```

## تسجيل الدخول الأولي

يجب إنشاء جلسة المتصفح بطريقة يدوية على جهاز موثوق ثم نقل مجلد الجلسة إلى الخادم، أو تشغيل المتصفح المرئي على الخادم عبر VNC/NoVNC. لا تضع كلمات المرور أو Cookies في `.env` أو GitHub.

بعد إنشاء الجلسة، أعد تشغيل الخدمة واستخدم فحص الجلسة. كل عملية Facebook تستخدم جلسة Facebook فقط، وكل عملية Pinterest تستخدم جلسة Pinterest فقط.

## حدود الصلاحيات

الجلسة المسجلة لا تمنح صلاحية تجاوز قيود المنصة. Facebook قد لا يعرض بيانات الصفحات التي لا يملك الحساب صلاحية رؤيتها، وPinterest قد يحجب بعض البيانات أو يتطلب صلاحيات الحساب. عند توفر OAuth الرسمي، يظل هو المسار المفضل للعدادات والتحليلات الدقيقة، بينما تستخدم الجلسة للمحتوى الظاهر.
