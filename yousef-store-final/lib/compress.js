'use strict';
/**
 * ضغط الردود (Brotli / Gzip) من غير أي حزمة خارجية.
 * - بيشتغل على أنواع النصوص بس (HTML/CSS/JS/JSON/XML/SVG/plain).
 * - بيتجاهل الردود الصغيرة (< 1KB) والصور والملفات المضغوطة أصلًا.
 * - بيحترم Accept-Encoding وبيضيف Vary: Accept-Encoding.
 */
const zlib = require('zlib');

const TEXT_RE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|ld\+json)|image\/svg\+xml)/i;
const MIN_BYTES = 1024;

function pickEncoding(header) {
  const accept = String(header || '').toLowerCase();
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

function compressSync(encoding, buffer) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(buffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length
      }
    });
  }
  return zlib.gzipSync(buffer, { level: 6 });
}

function compression() {
  return function compressionMiddleware(req, res, next) {
    if (req.method === 'HEAD') return next();
    const encoding = pickEncoding(req.headers['accept-encoding']);
    if (!encoding) return next();

    const originalSend = res.send.bind(res);
    res.send = function send(body) {
      try {
        if (res.headersSent || res.getHeader('Content-Encoding')) return originalSend(body);
        const type = String(res.getHeader('Content-Type') || '');
        if (!TEXT_RE.test(type)) return originalSend(body);

        const buffer = Buffer.isBuffer(body)
          ? body
          : typeof body === 'string'
            ? Buffer.from(body, 'utf8')
            : null;
        if (!buffer || buffer.length < MIN_BYTES) return originalSend(body);

        const out = compressSync(encoding, buffer);
        // لو الضغط ما وفّرش حاجة، ابعت الأصل.
        if (out.length >= buffer.length) return originalSend(body);

        res.setHeader('Content-Encoding', encoding);
        res.setHeader('Content-Length', String(out.length));
        res.removeHeader('ETag'); // الـ ETag بتاع النص الأصلي مش صالح للنسخة المضغوطة
        const vary = String(res.getHeader('Vary') || '');
        if (!/accept-encoding/i.test(vary)) {
          res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
        }
        return originalSend(out);
      } catch (_) {
        return originalSend(body);
      }
    };
    next();
  };
}

module.exports = { compression };
