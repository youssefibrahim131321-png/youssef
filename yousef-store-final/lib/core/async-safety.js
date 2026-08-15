// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
module.exports = function installAsyncSafety(deps = {}) {
  const { app, express } = deps;
  // ---------------------------------------------------------------------------
  // (إصلاح) شبكة أمان للـ handlers غير المتزامنة.
  // Express 4 مش بيمسك الـ Promise المرفوض، فأي throw جوه handler async كان
  // بيسيب الطلب معلّق للأبد (المتصفح/الاختبار يقع في timeout بدل ما يشوف 500).
  // هنا بنلف أي handler بيرجّع Promise فنمرّر الخطأ لـ next() ويتعامل معاه
  // معالج الأخطاء العام في آخر الملف. السلوك في المسار الناجح ما بيتغيّرش.
  // ---------------------------------------------------------------------------
  (() => {
  const wrap = (fn) => {
    if (typeof fn !== 'function' || fn.__asyncWrapped) return fn;
    if (fn.length >= 4) return fn; // معالج أخطاء: يفضل زي ما هو
    const wrapped = function (req, res, next) {
      let out;
      try { out = fn.call(this, req, res, next); }
      catch (error) { return next(error); }
      if (out && typeof out.then === 'function') out.catch(next);
      return out;
    };
    wrapped.__asyncWrapped = true;
    Object.defineProperty(wrapped, 'name', { value: fn.name });
    return wrapped;
  };
  const methods = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
  const patch = (target) => {
    for (const method of methods) {
      const original = target[method];
      if (typeof original !== 'function') continue;
      target[method] = function (...args) {
        return original.apply(this, args.map((arg) => (typeof arg === 'function' ? wrap(arg) : arg)));
      };
    }
  };
  patch(app);
  patch(express.Router);
  patch(require('express').application);
  })();
  return {  };
};
