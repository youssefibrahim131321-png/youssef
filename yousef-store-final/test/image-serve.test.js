const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createImageFormatMiddleware } = require('../lib/image-serve');

process.env.IMAGE_AUTO_FORMAT = 'on';

function get(port, urlPath, accept, extra = {}) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign(accept ? { accept } : {}, extra);
    const req = http.request({ port, path: urlPath, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves AVIF/WebP variants based on Accept header', async () => {
  let sharp;
  try { sharp = require('sharp'); } catch (_) { return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgfmt-'));
  const uploads = path.join(dir, 'uploads', 'products');
  fs.mkdirSync(uploads, { recursive: true });
  const source = path.join(uploads, 'demo.jpg');
  await sharp({ create: { width: 600, height: 600, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .jpeg({ quality: 100 }).toFile(source);

  const app = express();
  app.use(createImageFormatMiddleware({
    mount: '/uploads/products',
    rootDir: uploads,
    cacheDir: path.join(dir, 'cache')
  }));
  app.use('/uploads/products', express.static(uploads));

  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  try {
    const avif = await get(port, '/uploads/products/demo.jpg', 'image/avif,image/webp,*/*');
    assert.equal(avif.status, 200);
    assert.equal(avif.headers['content-type'], 'image/avif');
    assert.equal(avif.headers.vary, 'Accept');

    const webp = await get(port, '/uploads/products/demo.jpg', 'image/webp,*/*');
    assert.equal(webp.headers['content-type'], 'image/webp');

    const original = await get(port, '/uploads/products/demo.jpg', 'image/*');
    assert.match(String(original.headers['content-type']), /jpeg/);

    // كاش طويل + ETag قوي
    assert.match(String(avif.headers['cache-control']), /max-age=31536000/);
    assert.match(String(avif.headers['cache-control']), /immutable/);
    assert.ok(avif.headers.etag && !avif.headers.etag.startsWith('W/'), 'strong ETag');
    assert.ok(avif.headers['last-modified']);

    // revalidation بيرجّع 304 من غير جسم
    const revalidated = await get(port, '/uploads/products/demo.jpg', 'image/avif,*/*', {
      'if-none-match': avif.headers.etag
    });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body.length, 0);

    const byDate = await get(port, '/uploads/products/demo.jpg', 'image/avif,*/*', {
      'if-modified-since': avif.headers['last-modified']
    });
    assert.equal(byDate.status, 304);

    // النسخة المحوّلة اتعملت مرة واحدة بس
    const cached = fs.readdirSync(path.join(dir, 'cache', 'avif'));
    assert.equal(cached.length, 1);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
