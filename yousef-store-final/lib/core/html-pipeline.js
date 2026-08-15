const { truthy } = require('./bool');
// وحدة مستخرجة من server.js للحفاظ على حجم الملف الرئيسي صغير.
// المنطق زي ما هو بالحرف؛ التغيير الوحيد إن التوابع بتوصلها الاعتماديات كوسائط.
const { publicBaseUrlOrLocal } = require('./public-url');
module.exports = async function createHtmlPipeline(deps = {}) {
  const { PUBLIC_DIR, crypto, fs, injectProductSection, parseProductPath, path, productPath, store } = deps;
  // (4) بنقدّم صفحات الـ HTML بأنفسنا عشان نحقن الـ nonce في كل <script> داخلي
  // قبل الإرسال. الملفات التانية (CSS/JS/صور) بتكمل عادي على express.static.
  // (أداء) بصمة محتوى لكل أصل محلي (CSS/JS): بنحقنها في روابط الصفحات كـ ?v=hash
  // وبنقدّم الملف وقتها بكاش سنة كامل immutable. كده الكاش قوي وأي تعديل بيوصل
  // للمتصفح فورًا من غير bundler ولا خطوة بناء.
  const assetVersionCache = new Map();
  function assetVersion(urlPath) {
    const clean = urlPath.split('?')[0];
    const filePath = path.join(PUBLIC_DIR, clean);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return null;
    let stat;
    try { stat = fs.statSync(filePath); } catch (_) { return null; }
    if (!stat.isFile()) return null;
    const cached = assetVersionCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.version;
    const version = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex').slice(0, 10);
    assetVersionCache.set(filePath, { mtimeMs: stat.mtimeMs, version });
    return version;
  }
  // (إصلاح CSP) style-src-attr بقى 'none'، فأي style="..." في الـ HTML كان
  // هيتجاهله المتصفح. بدل ما نرجّع 'unsafe-inline' (اللي بيسمح لأي XSS يحقن
  // تنسيق ويعمل تشويه/تصيّد بصري)، بنحوّل كل خصائص style في الصفحة لكلاسات
  // مولّدة جوه بلوك <style> واحد بيحمل الـ nonce. النتيجة نفس الشكل بالحرف مع
  // CSP صارمة. الناتج بيتكاش مع الملف نفسه فالتحويل بيحصل مرة واحدة.
  function externalizeInlineStyles(html) {
    const classFor = new Map();
    let index = 0;
    const out = html.replace(/(<[^>]*?)\sstyle="([^"]*)"([^>]*>)/gi, (match, before, decl, after) => {
      const css = decl.trim().replace(/;+$/, '');
      if (!css) return before + after;
      let className = classFor.get(css);
      if (!className) {
        index += 1;
        className = `sx-${index}`;
        classFor.set(css, className);
      }
      const head = before + after;
      return /\sclass="/i.test(head)
        ? head.replace(/\sclass="([^"]*)"/i, (m, existing) => ` class="${existing} ${className}"`)
        : `${before} class="${className}"${after}`;
    });
    if (!classFor.size) return out;
    const rules = [...classFor.entries()].map(([css, cls]) => `.${cls}{${css}}`).join('');
    return out.replace(/<\/head>/i, `<style data-inline-styles>${rules}</style></head>`);
  }
  function versionAssets(html) {
    return html.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=")(\/[^"?#>]+\.(?:js|css))(")/gi, (match, a, url, b) => {
      if (/service-worker\.js$/i.test(url)) return match;
      const version = assetVersion(url);
      return version ? `${a}${url}?v=${version}${b}` : match;
    });
  }
  const htmlCache = new Map();
  function readHtml(filePath) {
    const stat = fs.statSync(filePath);
    const cached = htmlCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content;
    const content = fs.readFileSync(filePath, 'utf8');
    htmlCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      content
    });
    return content;
  }
  function injectNonce(html, nonce) {
    // (إصلاح CSP) الاستايلات اللي بيعملها الجافاسكريبت وقت التشغيل (theme.js /
    // notify-client.js) مكانش معاها nonce فكانت بتتحجب. بنمرّر الـ nonce للصفحة.
    html = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<script nonce="${nonce}">window.__CSP_NONCE__=${JSON.stringify(nonce)};</script>`);
    return html
      .replace(/<script(?![^>]*\bsrc=)([^>]*)>/gi, (match, attrs) => /\bnonce=/i.test(attrs) ? match : `<script${attrs} nonce="${nonce}">`)
      // (إصلاح CSP) بلوكات <style> بقت تاخد نفس الـ nonce، فقدرنا نشيل
      // 'unsafe-inline' من style-src من غير ما التنسيق يتكسر.
      .replace(/<style(?![^>]*\bnonce=)([^>]*)>/gi, (match, attrs) => `<style${attrs} nonce="${nonce}">`);
  }
  // (إصلاح SEO) og:url / og:image / twitter:image / canonical لازم تكون روابط
  // مطلقة، وإلا معاينة اللينك على واتساب وفيسبوك ما بتظهرش.
  function absolutizeSocialTags(html, req) {
    const base = publicBaseUrlOrLocal(req);
    const abs = value => /^https?:\/\//i.test(value) ? value : base + (value.startsWith('/') ? value : '/' + value);
    return html.replace(/(<meta\s+property="og:(?:url|image)"\s+content=")([^"]*)(")/gi, (m, a, v, b) => a + abs(v) + b).replace(/(<meta\s+name="twitter:image"\s+content=")([^"]*)(")/gi, (m, a, v, b) => a + abs(v) + b).replace(/(<link\s+rel="canonical"\s+href=")([^"]*)(")/gi, (m, a, v, b) => a + abs(v) + b).replace(/(<link\s+rel="alternate"\s+hreflang="[^"]*"\s+href=")([^"]*)(")/gi, (m, a, v, b) => a + abs(v) + b);
  }
  // (إصلاح SEO) صفحة المنتج بتتفتح كـ /?p=ID داخل تطبيق صفحة واحدة، فالمعاينة
  // على واتساب/فيسبوك وجوجل كانت بتبان بعنوان المتجر العام. هنا بنحقن بيانات
  // المنتج نفسه في الـ HTML قبل الإرسال + JSON-LD للأرشفة.
  function escAttr(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[c]);
  }
  // كاش قصير لقائمة المنتجات النشطة (تُستخدم في "منتجات مشابهة") عشان صفحة
  // المنتج ما تعملش استعلام كامل مع كل زيارة.
  let activeProductsCache = { at: 0, list: [] };
  const ACTIVE_PRODUCTS_TTL_MS = 30_000;
  async function getActiveProductsCached() {
    if (Date.now() - activeProductsCache.at < ACTIVE_PRODUCTS_TTL_MS) return activeProductsCache.list;
    const list = (await store.getProducts(true)) || [];
    activeProductsCache = { at: Date.now(), list };
    return list;
  }
  async function injectProductMeta(html, req) {
    const raw = req.query && req.query.p;
    const fromPath = parseProductPath(req.path);
    const id = fromPath || Number(Array.isArray(raw) ? raw[0] : raw);
    if (!Number.isInteger(id) || id <= 0) return html;
    let product = null;
    try {
      product = await store.getProductById(id);
    } catch (_) {
      return html;
    }
    if (!product || !truthy(product.active)) return html;
    const base = publicBaseUrlOrLocal(req);
    const abs = v => !v ? base + '/icon-512.png' : /^https?:\/\//i.test(v) ? v : base + (v.startsWith('/') ? v : '/' + v);
    const title = `${product.name} — يوسف | مستلزمات العربيات`;
    const desc = String(product.description || `${product.name} متوفر في متجر يوسف بسعر ${product.price} ج.م مع توصيل لحد باب البيت.`).replace(/\s+/g, ' ').trim().slice(0, 180);
    const image = abs(product.image_url || product.image);
    const url = `${base}${productPath(product)}`;
    const set = (h, re, replacement) => re.test(h) ? h.replace(re, replacement) : h;
    let out = html;
    out = set(out, /<title>[\s\S]*?<\/title>/i, `<title>${escAttr(title)}</title>`);
    out = set(out, /(<meta\s+name="description"\s+content=")[^"]*(")/i, `$1${escAttr(desc)}$2`);
    out = set(out, /(<meta\s+property="og:title"\s+content=")[^"]*(")/i, `$1${escAttr(title)}$2`);
    out = set(out, /(<meta\s+property="og:description"\s+content=")[^"]*(")/i, `$1${escAttr(desc)}$2`);
    out = set(out, /(<meta\s+property="og:image"\s+content=")[^"]*(")/i, `$1${escAttr(image)}$2`);
    out = set(out, /(<meta\s+property="og:url"\s+content=")[^"]*(")/i, `$1${escAttr(url)}$2`);
    out = set(out, /(<meta\s+property="og:type"\s+content=")[^"]*(")/i, '$1product$2');
    out = set(out, /(<meta\s+name="twitter:title"\s+content=")[^"]*(")/i, `$1${escAttr(title)}$2`);
    out = set(out, /(<meta\s+name="twitter:description"\s+content=")[^"]*(")/i, `$1${escAttr(desc)}$2`);
    out = set(out, /(<meta\s+name="twitter:image"\s+content=")[^"]*(")/i, `$1${escAttr(image)}$2`);
    out = set(out, /(<link\s+rel="canonical"\s+href=")[^"]*(")/i, `$1${escAttr(url)}$2`);
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.name,
      description: desc,
      image: [image],
      sku: String(product.id),
      brand: {
        '@type': 'Brand',
        name: 'يوسف | مستلزمات العربيات'
      },
      offers: {
        '@type': 'Offer',
        url,
        priceCurrency: 'EGP',
        price: Number(product.price || 0).toFixed(2),
        availability: product.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock'
      }
    }).replace(/</g, '\\u003c');
    out = out.replace(/<\/head>/i, `<script type="application/ld+json">${jsonLd}</script></head>`);
    // (إصلاح SEO) SSR فعلي: بنولّد محتوى المنتج نفسه في HTML — عنوان H1، سعر،
    // وصف، صورة مع alt، توفّر، ومنتجات مشابهة كلينكات حقيقية — عشان الزاحف
    // يشوف صفحة كاملة من غير تنفيذ جافاسكربت.
    let siblings = [];
    try {
      siblings = await getActiveProductsCached();
    } catch (_) {
      siblings = [];
    }
    return injectProductSection(out, product, siblings);
  }
  async function sendHtml(res, filePath) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    let html = readHtml(filePath);
    // (إصلاح) injectProductMeta بقت async (بتستخدم store.getProductById)، لازم await
    if (path.basename(filePath) === 'index.html') html = await injectProductMeta(html, res.req);
    html = absolutizeSocialTags(html, res.req);
    html = versionAssets(html);
    html = externalizeInlineStyles(html);
    res.send(injectNonce(html, res.locals.cspNonce));
  }
  return { assetVersion, sendHtml };
};
