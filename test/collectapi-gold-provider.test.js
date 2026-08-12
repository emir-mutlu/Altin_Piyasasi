const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COLLECTAPI_GOLD_PATH,
  COLLECTAPI_ORIGIN,
  CollectApiDataError,
  CollectApiGoldProvider,
  PRODUCT_ALIASES,
  buildCollectApiUrl,
  parseCollectApiPrice,
  parseRetryAfter,
  validateCollectApiPayload,
} = require('../services/collectapi-gold-provider');
const {
  GoldPriceUnavailableError,
} = require('../services/metals-dev-gold-provider');

const BASE_NOW = Date.parse('2026-08-12T12:00:00.000Z');
const TEST_TOKEN = 'TEST_COLLECTAPI_TOKEN_DO_NOT_LEAK';

function collectPayload(result = []) {
  return { success: true, result };
}

function allProducts() {
  return [
    { name: 'Çeyrek Altın', buy: '7.100,50', sell: '7.250,75' },
    { name: 'Yarım Altın', buy: '14.201,00', sell: '14.501,50' },
    { name: 'Tam Altın', buy: '28.402,00', sell: '29.003,00' },
    { name: 'Cumhuriyet Altını', buy: '29.100,00', sell: '29.500,00' },
    { name: 'Ata Altın', buy: '29.300,00', sell: '29.700,00' },
    { name: 'Reşat Altını', buy: '29.400,00', sell: '29.800,00' },
    { name: '22 Ayar Altın TL/Gr', buy: '4.050,25', sell: '4.110,75' },
  ];
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function provider(options = {}) {
  return new CollectApiGoldProvider({
    token: TEST_TOKEN,
    now: () => BASE_NOW,
    fetchImpl: async () => jsonResponse(collectPayload(allProducts())),
    ...options,
  });
}

test('sabit HTTPS CollectAPI endpointini ve backend Authorization headerını kullanır', async () => {
  let requestUrl;
  let requestOptions;
  const instance = provider({
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestOptions = options;
      return jsonResponse(collectPayload(allProducts()));
    },
  });

  await instance.getPrices();

  assert.equal(requestUrl.origin, COLLECTAPI_ORIGIN);
  assert.equal(requestUrl.pathname, COLLECTAPI_GOLD_PATH);
  assert.equal(requestUrl.search, '');
  assert.equal(requestOptions.headers.authorization, `apikey ${TEST_TOKEN}`);
  assert.equal(requestUrl.href.includes(TEST_TOKEN), false);
  assert.equal(buildCollectApiUrl().href, `${COLLECTAPI_ORIGIN}${COLLECTAPI_GOLD_PATH}`);
});

test('yedi fiziksel ürünü açık alias map ile canonical kodlara dönüştürür', () => {
  const rows = validateCollectApiPayload(collectPayload(allProducts()));
  assert.deepEqual(
    rows.map((row) => row.code),
    ['CEYREK', 'YARIM', 'TAM', 'CUMHURIYET', 'ATA', 'RESAT', 'ALTIN_22'],
  );
  assert.equal(PRODUCT_ALIASES.get('çeyrek altın'), 'CEYREK');
  assert.equal(PRODUCT_ALIASES.get('22 ayar altın tl/gr'), 'ALTIN_22');
});

test('ürün adında yalnızca boşluk, Unicode ve Türkçe harf normalizasyonu uygular', () => {
  const rows = validateCollectApiPayload(
    collectPayload([
      { name: '  ÇEYREK   ALTIN  ', buy: '1', sell: '2' },
      { name: 'Reşat Altın', buy: '3', sell: '4' },
    ]),
  );
  assert.deepEqual(rows.map((row) => row.code), ['CEYREK', 'RESAT']);
});

test('benzer ve bilinmeyen ürünleri fuzzy eşleştirme yapmadan yok sayar', () => {
  const rows = validateCollectApiPayload(
    collectPayload([
      { name: 'Çeyrek Ziynet', buy: '1', sell: '2' },
      { name: 'Tam Altınlık', buy: '1', sell: '2' },
      { name: 'Ata Lira', buy: '1', sell: '2' },
      { name: '22 Ayar Bilezik', buy: '1', sell: '2' },
      { name: 'Gremse Altın', buy: '1', sell: '2' },
    ]),
  );
  assert.deepEqual(rows, []);
});

test('aynı canonical ürün için birden fazla kesin alias eşleşmesini reddeder', () => {
  assert.throws(
    () =>
      validateCollectApiPayload(
        collectPayload([
          { name: 'Reşat Altın', buy: '1', sell: '2' },
          { name: 'Reşat Altını', buy: '3', sell: '4' },
        ]),
      ),
    CollectApiDataError,
  );
});

test('Türkçe ve dokümante noktalı ondalık fiyatları güvenli ayrıştırır', () => {
  assert.equal(parseCollectApiPrice('44.728,56'), 44_728.56);
  assert.equal(parseCollectApiPrice('257.4107'), 257.4107);
  assert.equal(parseCollectApiPrice('44728,56'), 44_728.56);
  assert.equal(parseCollectApiPrice('₺44.728,56'), 44_728.56);
  assert.equal(parseCollectApiPrice('TL 44.728,56'), 44_728.56);
  assert.equal(parseCollectApiPrice(44_728.56), 44_728.56);
});

test('boş, çizgi, NaN, Infinity, negatif, sıfır ve bozuk fiyatları null yapar', () => {
  for (const value of [
    '',
    ' ',
    '-',
    'NaN',
    'Infinity',
    NaN,
    Infinity,
    -1,
    0,
    '-1',
    '0',
    '44.728.56',
    '44,728.56',
    {},
  ]) {
    assert.equal(parseCollectApiPrice(value), null, String(value));
  }
});

test('gerçek buy/sell kullanır; ayrı fiyat yoksa sell değerini price yapar', () => {
  const [row] = validateCollectApiPayload(
    collectPayload([
      {
        name: 'Çeyrek Altın',
        buy: '7.100,50',
        sell: '7.250,75',
        change: '99',
        changePercent: '88',
      },
    ]),
  );
  assert.equal(row.buy, 7_100.5);
  assert.equal(row.sell, 7_250.75);
  assert.equal(row.price, 7_250.75);
  assert.equal(row.reference, 7_250.75);
  assert.equal(row.change, null);
  assert.equal(row.changePercent, null);
  assert.equal(row.isEstimated, false);
});

test('doğrulanabilir current/price/last alanını sell değerinden önce kullanır', () => {
  for (const [field, value] of [
    ['current', '7.200,00'],
    ['price', '7.210,00'],
    ['last', '7.220,00'],
  ]) {
    const [row] = validateCollectApiPayload(
      collectPayload([
        { name: 'Çeyrek Altın', buy: '7.100', sell: '7.300', [field]: value },
      ]),
    );
    assert.equal(row.price, parseCollectApiPrice(value));
  }
});

test('mevcut ama bozuk current alanını sell ile gizlemez', () => {
  const [row] = validateCollectApiPayload(
    collectPayload([
      { name: 'Çeyrek Altın', buy: '7100', sell: '7300', current: 'broken' },
    ]),
  );
  assert.equal(row.buy, 7_100);
  assert.equal(row.sell, 7_300);
  assert.equal(row.price, null);
  assert.equal(row.reference, null);
});

test('geçersiz response envelope ve result yapısını reddeder', () => {
  for (const payload of [null, [], {}, { success: false, result: [] }, { success: true }]) {
    assert.throws(() => validateCollectApiPayload(payload), CollectApiDataError);
  }
});

test('HTTP 401 ve 403 yapılandırma hatalarında blok süresince yeniden fetch yapmaz', async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    const instance = provider({
      fetchImpl: async () => {
        calls += 1;
        return new Response('', { status });
      },
    });
    await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
    await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
    assert.equal(calls, 1);
  }
});

test('HTTP 429 Retry-After değerini uygular', async () => {
  let calls = 0;
  const instance = provider({
    fetchImpl: async () => {
      calls += 1;
      return new Response('', {
        status: 429,
        headers: { 'retry-after': '120' },
      });
    },
  });
  await assert.rejects(
    instance.getPrices(),
    (error) => error.retryAfterSeconds >= 120,
  );
  await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
  assert.equal(calls, 1);
  assert.equal(
    parseRetryAfter('Wed, 12 Aug 2026 12:02:00 GMT', BASE_NOW),
    120_000,
  );
});

test('HTTP 500 ve malformed JSON cache yokken güvenli 503 üretir', async () => {
  for (const response of [
    new Response('', { status: 500 }),
    new Response('{broken', { status: 200 }),
  ]) {
    const instance = provider({ fetchImpl: async () => response });
    await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
  }
});

test('timeout olduğunda cache yoksa güvenli 503 üretir', async () => {
  const instance = provider({
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });
  await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
});

test('Content-Length ve stream byte limitlerini ayrı ayrı uygular', async () => {
  const responses = [
    new Response('{}', {
      status: 200,
      headers: { 'content-length': '1000' },
    }),
    new Response('x'.repeat(1000), { status: 200 }),
  ];
  for (const response of responses) {
    const instance = provider({
      maxResponseBytes: 64,
      fetchImpl: async () => response,
    });
    await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
  }
});

test('token eksikliğinde harici istek başlatmaz', async () => {
  let calls = 0;
  const instance = provider({
    token: '',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(collectPayload(allProducts()));
    },
  });
  await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
  assert.equal(calls, 0);
  assert.equal(instance.status().configured, false);
});

test('cache hit çağrı yapmaz, expiry sonrası cache miss yeniler', async () => {
  let clock = BASE_NOW;
  let calls = 0;
  const instance = provider({
    now: () => clock,
    cacheTtlMs: 60_000,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(collectPayload(allProducts()));
    },
  });
  await instance.getPrices();
  await instance.getPrices();
  assert.equal(calls, 1);
  clock += 60_001;
  await instance.getPrices();
  assert.equal(calls, 2);
});

test('eşzamanlı cache miss isteklerini tek in-flight fetchte birleştirir', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const instance = provider({
    fetchImpl: async () => {
      calls += 1;
      await pending;
      return jsonResponse(collectPayload(allProducts()));
    },
  });
  const first = instance.getPrices();
  const second = instance.getPrices();
  release();
  assert.strictEqual(await first, await second);
  assert.equal(calls, 1);
});

test('başarılı son veriyi stale sınırı içinde korur, sınır dışında sunmaz', async () => {
  let clock = BASE_NOW;
  let calls = 0;
  const instance = provider({
    now: () => clock,
    cacheTtlMs: 30_000,
    staleMaxAgeMs: 90_000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(collectPayload(allProducts()));
      }
      throw new Error('network unavailable');
    },
  });
  const fresh = await instance.getPrices();
  clock += 30_001;
  const stale = await instance.getPrices();
  assert.equal(fresh.freshness, 'fresh');
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.staleAgeSeconds, 30);

  clock += 90_001;
  await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
});

test('mock token response, hata mesajı veya provider statusuna sızmaz', async () => {
  const success = await provider().getPrices();
  assert.equal(JSON.stringify(success).includes(TEST_TOKEN), false);
  assert.equal(JSON.stringify(provider().status()).includes(TEST_TOKEN), false);

  const failed = provider({
    fetchImpl: async () => new Response('', { status: 500 }),
  });
  await assert.rejects(
    failed.getPrices(),
    (error) => !String(error).includes(TEST_TOKEN),
  );
});
