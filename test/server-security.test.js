const assert = require('node:assert/strict');
const test = require('node:test');
const {
  InMemoryRateLimiter,
  createAppServer,
} = require('../server');

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
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('güvenlik başlıklarını statik ve JSON yanıtlara ekler', async () => {
  await withServer({}, async (baseUrl) => {
    for (const path of ['/', '/health']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
      assert.match(response.headers.get('permissions-policy'), /camera=\(\)/);
    }
  });
});

test('production ortamında HSTS başlığı ekler', async () => {
  await withServer({ env: { NODE_ENV: 'production' } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.match(response.headers.get('strict-transport-security'), /max-age=31536000/);
  });
});

test('POST /health 405 ve doğru Allow başlığı döndürür', async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  });
});

test('POST /api/prices 405 döndürür ve providerı çağırmaz', async () => {
  let calls = 0;
  await withServer(
    {
      priceProvider: {
        isConfigured: () => true,
        status: () => ({ provider: 'metals_dev', configured: true }),
        getPrices: async () => {
          calls += 1;
          return { rows: [] };
        },
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/prices`, { method: 'POST' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
      assert.equal(calls, 0);
    },
  );
});

test('static içerik HEAD destekler, diğer metotları reddeder ve bilinmeyen rota 404 olur', async () => {
  await withServer({}, async (baseUrl) => {
    const head = await fetch(`${baseUrl}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    const post = await fetch(`${baseUrl}/`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');

    assert.equal((await fetch(`${baseUrl}/missing-page`)).status, 404);
  });
});

test('rate limit 429 ve Retry-After döndürür, X-Forwarded-For değerine güvenmez', async () => {
  const limiter = new InMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
  await withServer({ priceLimiter: limiter }, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/prices`, {
      headers: { 'x-forwarded-for': '198.51.100.1' },
    });
    const second = await fetch(`${baseUrl}/api/prices`, {
      headers: { 'x-forwarded-for': '203.0.113.5' },
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '60');
  });
});

test('API key eksikliğinde health çalışır ve prices güvenli 503 döndürür', async () => {
  const server = createAppServer({
    env: { NODE_ENV: 'production', GOLD_PROVIDER: 'metals_dev' },
    getNews: async () => ({ items: [] }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${baseUrl}/health`);
    const healthPayload = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthPayload.ready, false);

    const prices = await fetch(`${baseUrl}/api/prices`);
    const priceText = await prices.text();
    assert.equal(prices.status, 503);
    assert.equal(priceText.includes('api_key'), false);
    assert.equal(priceText.includes('METALS_DEV_API_KEY'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
