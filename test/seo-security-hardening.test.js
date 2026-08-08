const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  createAppServer,
  readLimitedResponseText,
  safeExternalHttpsUrl,
} = require('../server');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function withServer(options, run) {
  const server = createAppServer({
    env: { NODE_ENV: 'test', GOLD_PROVIDER: 'metals_dev' },
    priceProvider: {
      isConfigured: () => true,
      status: () => ({ provider: 'metals_dev', configured: true }),
      getPrices: async () => ({ source: 'Metals.dev', rows: [] }),
    },
    getNews: async () => ({ source: 'test', items: [] }),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('homepage doğru teknik SEO metadata alanlarını içerir', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="tr">/i);
  assert.match(html, /<meta charset="utf-8">/i);
  assert.match(html, /name="viewport"/i);
  assert.match(html, /<title>Altın Piyasası \| Gram ve Ons Global Spot Altın Fiyatları<\/title>/);
  assert.match(html, /name="description"/i);
  assert.match(html, /name="robots" content="index, follow,/i);
  assert.match(html, /property="og:title"/i);
  assert.match(html, /property="og:description"/i);
  assert.match(html, /property="og:type" content="website"/i);
  assert.match(html, /property="og:locale" content="tr_TR"/i);
  assert.doesNotMatch(html, /name="keywords"/i);
  assert.doesNotMatch(html, /rel="canonical"/i);
  assert.doesNotMatch(html, /property="og:url"/i);
  assert.doesNotMatch(html, /property="og:image"/i);
});

test('robots.txt homepage taramasına izin verir ve API rotalarını dışlar', () => {
  const robots = fs.readFileSync(path.join(PUBLIC_DIR, 'robots.txt'), 'utf8');

  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Disallow: \/health$/m);
  assert.doesNotMatch(robots, /^Sitemap:/m);
});

test('homepage indexlenebilir kalır, API ve health X-Robots-Tag ile noindex olur', async () => {
  await withServer({}, async (baseUrl) => {
    const homepage = await fetch(`${baseUrl}/`);
    assert.equal(homepage.status, 200);
    assert.equal(homepage.headers.get('x-robots-tag'), null);
    assert.doesNotMatch(await homepage.text(), /name="robots" content="noindex/i);

    for (const route of ['/api/prices', '/api/news', '/health']) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get('x-robots-tag'),
        'noindex, nofollow, noarchive',
      );
    }
  });
});

test('robots ve statik assetler güvenli Content-Type ve cache politikası döndürür', async () => {
  await withServer({}, async (baseUrl) => {
    const homepage = await fetch(`${baseUrl}/`);
    assert.match(homepage.headers.get('content-type'), /^text\/html/);
    assert.equal(homepage.headers.get('content-language'), 'tr');
    assert.equal(homepage.headers.get('cache-control'), 'no-store');

    const stylesheet = await fetch(`${baseUrl}/styles.css`);
    assert.match(stylesheet.headers.get('content-type'), /^text\/css/);
    assert.equal(stylesheet.headers.get('cache-control'), 'public, max-age=3600');
    assert.doesNotMatch(stylesheet.headers.get('cache-control'), /immutable/);

    const robots = await fetch(`${baseUrl}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type'), /^text\/plain/);
    assert.equal(robots.headers.get('cache-control'), 'public, max-age=300');
  });
});

test('CSP uzak görsel, inline script ve eval izni vermeden mevcut assetleri destekler', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const csp = response.headers.get('content-security-policy');

    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /img-src 'self' data:/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|img-src[^;]*https:/);
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});

test('traversal, encoded traversal, Windows ayırıcıları ve dotfile istekleri reddedilir', async () => {
  await withServer({}, async (baseUrl) => {
    const deniedPaths = [
      '/.env',
      '/.git/config',
      '/nested/.private',
      '/%2eenv',
      '/%2e%2e%2fserver.js',
      '/%2e%2e%5cserver.js',
      '/server.js',
    ];

    for (const deniedPath of deniedPaths) {
      const response = await fetch(`${baseUrl}${deniedPath}`);
      assert.notEqual(response.status, 200, deniedPath);
      assert.doesNotMatch(await response.text(), /TEST_SECRET_DO_NOT_LEAK/);
    }

    const malformedPath = await fetch(`${baseUrl}/%00`);
    assert.equal(malformedPath.status, 400);
  });
});

test('production 500 response ve logları hata mesajındaki mock secretı sızdırmaz', async () => {
  const mockSecret = 'TEST_SECRET_DO_NOT_LEAK';
  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);

  try {
    await withServer(
      {
        priceProvider: {
          isConfigured: () => true,
          status: () => ({ provider: 'metals_dev', configured: true }),
          getPrices: async () => {
            throw new Error(`Internal failure: ${mockSecret}`);
          },
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/prices`);
        const body = await response.text();
        assert.equal(response.status, 500);
        assert.doesNotMatch(body, new RegExp(mockSecret));
        assert.doesNotMatch(body, /\bat\s+\S+|node:internal|[A-Z]:\\/i);
      },
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.doesNotMatch(JSON.stringify(logs), new RegExp(mockSecret));
});

test('haber URL allowlist yalnızca HTTPS protokolüne izin verir', () => {
  assert.equal(
    safeExternalHttpsUrl('https://example.com/news'),
    'https://example.com/news',
  );
  for (const value of [
    'http://example.com/news',
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///tmp/news',
    'not-a-url',
  ]) {
    assert.equal(safeExternalHttpsUrl(value), null);
  }
});

test('harici haber response body boyutu Content-Length olsa da olmasa da sınırlıdır', async () => {
  const declaredOversize = new Response('small', {
    headers: { 'content-length': '100' },
  });
  await assert.rejects(
    () => readLimitedResponseText(declaredOversize, 10),
    /safe size limit/,
  );

  const streamedOversize = new Response('x'.repeat(32));
  await assert.rejects(
    () => readLimitedResponseText(streamedOversize, 10),
    /safe size limit/,
  );
});
