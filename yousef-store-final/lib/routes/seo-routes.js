/**
 * robots.txt و sitemap.xml
 * -------------------------------------------------------------------------
 * موديول اتفصل من server.js عشان الملف ما يبقاش آلاف السطور. كل الاعتماديات
 * (الـ store والحدود والمساعدات) بتتمرّر من server.js في كائن deps واحد،
 * فالسلوك زي ما هو بالحرف بس التنظيم بقى أوضح.
 */
const { publicBaseUrlOrLocal } = require('../core/public-url');

module.exports = function registerSeoRoutes(app, deps) {
  const {
    productPath,
    store
  } = deps;

  // (إصلاح) الأساس بياخد SITE_URL الأول زي باقي وسوم SEO في السيرفر، عشان
  // الروابط في sitemap ما تطلعش بدومين البروكسي أو localhost.
  // (إصلاح أمني) ممنوع السقوط على هيدر Host الخام: كان يسمح بتسميم
  // sitemap/robots بدومين خارجي (SEO/cache poisoning) لو SITE_URL مش مضبوط.
  const baseUrl = req => publicBaseUrlOrLocal(req);
  // (إصلاح) الصفحات الخاصة بالحساب والطلبات كانت ناقصة من robots، فكانت
  // معرّضة تتفهرس كصفحات فاضية أو تتحسب soft-404.
  const DISALLOW = ['/admin.html', '/js/admin/', '/admin.css', '/admin-login.html', '/dashboard.html', '/account.html', '/checkout.html', '/order-status.html', '/verify-email.html', '/reset-password.html', '/forgot-password.html', '/api/', '/uploads/proofs/'];

  app.get('/robots.txt', (req, res) => {
    const base = baseUrl(req);
    res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(`User-agent: *\nAllow: /\n${DISALLOW.map(p => `Disallow: ${p}`).join('\n')}\n\nSitemap: ${base}/sitemap.xml\n`);
  });

  app.get('/sitemap.xml', async (req, res) => {
    const base = baseUrl(req);
    let products = [];
    try {
      products = (await store.getProducts(true)) || [];
    } catch (err) {
      console.error('[sitemap] فشل تحميل المنتجات:', err.message);
    }
    const escXml = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
    const staticUrls = [{
      loc: `${base}/`,
      changefreq: 'daily',
      priority: '1.0'
    }, {
      loc: `${base}/shipping.html`,
      changefreq: 'monthly',
      priority: '0.5'
    }, {
      loc: `${base}/returns.html`,
      changefreq: 'monthly',
      priority: '0.5'
    }, {
      loc: `${base}/privacy.html`,
      changefreq: 'yearly',
      priority: '0.4'
    }];
    // (إصلاح 10) مسارات حقيقية /product/<id>/<slug> بدل query string.
    // (إصلاح) الروابط بتتـ encode + lastmod من تاريخ تحديث المنتج نفسه لما يكون متاح.
    const productUrls = products.map(p => {
      const stamp = p.updated_at || p.created_at;
      const date = stamp ? new Date(stamp) : null;
      return {
        loc: encodeURI(`${base}${productPath(p)}`),
        lastmod: date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null,
        changefreq: 'weekly',
        priority: '0.7'
      };
    });
    const urls = [...staticUrls, ...productUrls].map(u => ['  <url>', `    <loc>${escXml(u.loc)}</loc>`, u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>` : null, u.changefreq ? `    <changefreq>${u.changefreq}</changefreq>` : null, `    <priority>${u.priority}</priority>`, '  </url>'].filter(Boolean).join('\n'));
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
    res.type('application/xml').set('Cache-Control', 'public, max-age=1800').send(xml);
  });
};
