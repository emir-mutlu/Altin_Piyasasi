const assert = require('node:assert/strict');
const test = require('node:test');
const {
  COLLECTAPI_GOLD_PATH,
  COLLECTAPI_ORIGIN,
  CollectApiDataError,
  CollectApiGoldProvider,
  PRODUCT_ALIASES,
  buildCollectApiUrl,
  parseCollectApiPayload,
  parseCollectApiPrice,
  parseCollectApiRate,
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

function liveProduct(name, buying, selling, overrides = {}) {
  return {
    name,
    buying,
    buyingstr: String(buying),
    selling,
    sellingstr: String(selling),
    time: '19:18:22',
    date: '2026-08-12',
    datetime: '2026-08-12T19:18:22.000Z',
    rate: 1.27,
    ...overrides,
  };
}

function allProducts() {
  return [
    liveProduct('Çeyrek Altın', 11_004.81, 11_179.93),
    liveProduct('Çeyrek Altın Eski', 10_900.75, 11_050.5),
    liveProduct('Yarım Altın', 22_009.62, 22_359.86),
    liveProduct('Yarım Altın Eski', 21_800.5, 22_100.25),
    liveProduct('Tam Altın', 44_019.24, 44_719.72),
    liveProduct('Tam Altın Eski', 43_600.75, 44_200.5),
    liveProduct('Cumhuriyet Altını', 45_100.25, 45_820.5),
    liveProduct('Ata Altın', 45_300.4, 46_020.75),
    liveProduct('Reşat Lira Altın', 46_000.5, 46_800.9),
    liveProduct('22 Ayar Bilezik', 4_050.25, 4_110.75),
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

test('on fiziksel ürünü açık alias map ile canonical kodlara dönüştürür', () => {
  const rows = validateCollectApiPayload(collectPayload(allProducts()));
  assert.deepEqual(
    rows.map((row) => row.code),
    [
      'CEYREK',
      'CEYREK_ESKI',
      'YARIM',
      'YARIM_ESKI',
      'TAM',
      'TAM_ESKI',
      'CUMHURIYET',
      'ATA',
      'RESAT',
      'ALTIN_22',
    ],
  );
  assert.equal(PRODUCT_ALIASES.get('çeyrek altın'), 'CEYREK');
  assert.equal(PRODUCT_ALIASES.get('çeyrek altın eski'), 'CEYREK_ESKI');
  assert.equal(PRODUCT_ALIASES.get('yarım altın eski'), 'YARIM_ESKI');
  assert.equal(PRODUCT_ALIASES.get('tam altın eski'), 'TAM_ESKI');
  assert.equal(PRODUCT_ALIASES.get('reşat lira altın'), 'RESAT');
  assert.equal(PRODUCT_ALIASES.get('22 ayar bilezik'), 'ALTIN_22');
});

test('güncel ve eski Çeyrek, Yarım ve Tam ürünlerini kesin olarak ayırır', () => {
  const rows = validateCollectApiPayload(
    collectPayload([
      liveProduct('Çeyrek Altın', 1, 2),
      liveProduct('Çeyrek Altın Eski', 3, 4),
      liveProduct('Yarım Altın', 5, 6),
      liveProduct('Yarım Altın Eski', 7, 8),
      liveProduct('Tam Altın', 9, 10),
      liveProduct('Tam Altın Eski', 11, 12),
    ]),
  );
  assert.deepEqual(
    rows.map((row) => [row.code, row.name]),
    [
      ['CEYREK', 'Çeyrek Altın'],
      ['CEYREK_ESKI', 'Eski Çeyrek Altın'],
      ['YARIM', 'Yarım Altın'],
      ['YARIM_ESKI', 'Eski Yarım Altın'],
      ['TAM', 'Tam Altın'],
      ['TAM_ESKI', 'Eski Tam Altın'],
    ],
  );
});

test('ürün adında yalnızca boşluk, Unicode ve Türkçe harf normalizasyonu uygular', () => {
  const rows = validateCollectApiPayload(
    collectPayload([
      liveProduct('  ÇEYREK   ALTIN  ', 1, 2),
      liveProduct('REŞAT LİRA ALTIN', 3, 4),
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
      { name: 'Reşat İkibuçuk Altın', buy: '1', sell: '2' },
      { name: 'Reşat Beşibiryerde', buy: '1', sell: '2' },
      { name: 'Kulplu Reşat', buy: '1', sell: '2' },
      { name: '14 Ayar Altın', buy: '1', sell: '2' },
      { name: '18 Ayar Altın', buy: '1', sell: '2' },
      { name: '22 Ayar Altın TL/Gr', buy: '1', sell: '2' },
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
          liveProduct('Reşat Lira Altın', 1, 2),
          liveProduct('Reşat Lira Altın', 3, 4),
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

test('rate alanında pozitif, negatif, sıfır ve numeric string değerleri korur', () => {
  for (const [value, expected] of [
    [1.27, 1.27],
    [-0.46, -0.46],
    [0, 0],
    ['1.27', 1.27],
    ['-0.46', -0.46],
    ['0', 0],
  ]) {
    assert.equal(parseCollectApiRate(value), expected, String(value));
  }
});

test('bozuk ve sonlu olmayan rate değerlerini null yapar', () => {
  for (const value of [
    'abc',
    '',
    ' ',
    '-',
    'NaN',
    'Infinity',
    NaN,
    Infinity,
    -Infinity,
    null,
    undefined,
    {},
    [],
    true,
    false,
  ]) {
    assert.equal(parseCollectApiRate(value), null, String(value));
  }
});

test('canlı buying/selling alanlarını kullanır ve selling değerini price yapar', () => {
  const [row] = validateCollectApiPayload(
    collectPayload([
      liveProduct('Çeyrek Altın', 11_004.81, 11_179.93),
    ]),
  );
  assert.equal(row.buy, 11_004.81);
  assert.equal(row.sell, 11_179.93);
  assert.equal(row.price, 11_179.93);
  assert.equal(row.reference, 11_179.93);
  assert.equal(row.change, null);
  assert.equal(row.changePercent, 1.27);
  assert.equal(row.isEstimated, false);
});

test('numeric canlı alanları string ve eski alanlardan önce kullanır', () => {
  const [row] = validateCollectApiPayload(
    collectPayload([
      liveProduct('Çeyrek Altın', 11_004.81, 11_179.93, {
        buyingstr: '1',
        sellingstr: '2',
        buy: '3',
        sell: '4',
      }),
    ]),
  );
  assert.equal(row.buy, 11_004.81);
  assert.equal(row.sell, 11_179.93);
  assert.equal(row.price, 11_179.93);
});

test('buyingstr/sellingstr ve eski buy/sell şemaları geriye uyumlu çalışır', () => {
  const rows = validateCollectApiPayload(
    collectPayload([
      liveProduct('Çeyrek Altın', undefined, undefined, {
        buyingstr: '11.004,81',
        sellingstr: '11.179,93',
      }),
      {
        name: 'Yarım Altın',
        buy: '22.009,62',
        sell: '22.359,86',
        buyingstr: '1',
        sellingstr: '2',
      },
    ]),
  );
  assert.deepEqual(
    rows.map((row) => [row.buy, row.sell, row.price]),
    [
      [11_004.81, 11_179.93, 11_179.93],
      [22_009.62, 22_359.86, 22_359.86],
    ],
  );
});

test('malformed canlı ve fallback fiyatlarından değer üretmez', () => {
  const [row] = validateCollectApiPayload(
    collectPayload([
      liveProduct('Çeyrek Altın', NaN, Infinity, {
        buyingstr: 'broken',
        sellingstr: '-1',
        buy: 0,
        sell: -1,
      }),
    ]),
  );
  assert.equal(row.buy, null);
  assert.equal(row.sell, null);
  assert.equal(row.price, null);
  assert.equal(row.reference, null);
});

test('geçerli datetime source timestamp olur, date ve time yeniden birleştirilmez', async () => {
  const parsed = parseCollectApiPayload(collectPayload(allProducts()));
  assert.equal(parsed.sourceTimestamp, '2026-08-12T19:18:22.000Z');

  const result = await provider().getPrices();
  assert.equal(result.sourceTimestamp, '2026-08-12T19:18:22.000Z');
  assert.equal(result.sourceDate, '2026-08-12T19:18:22.000Z');

  const withoutDatetime = parseCollectApiPayload(
    collectPayload([
      liveProduct('Çeyrek Altın', 1, 2, { datetime: 'invalid' }),
    ]),
  );
  assert.equal(withoutDatetime.sourceTimestamp, null);
});

test('rate alanını yalnızca changePercent olarak pozitif, negatif ve sıfırla eşler', () => {
  const rows = validateCollectApiPayload(
    collectPayload([
      liveProduct('Çeyrek Altın', 1, 2, { rate: 1.27 }),
      liveProduct('Yarım Altın', 3, 4, { rate: -0.46 }),
      liveProduct('Tam Altın', 5, 6, { rate: 0 }),
    ]),
  );
  assert.deepEqual(
    rows.map((row) => [row.change, row.changePercent]),
    [
      [null, 1.27],
      [null, -0.46],
      [null, 0],
    ],
  );
});

test('rate alanını on fiziksel CollectAPI ürününün tamamına uygular', () => {
  const rows = validateCollectApiPayload(collectPayload(allProducts()));
  assert.equal(rows.length, 10);
  assert.equal(rows.every((row) => row.change === null), true);
  assert.deepEqual(rows.map((row) => row.changePercent), Array(10).fill(1.27));
});

test('eski ürünlerde gerçek alış, satış, reference ve rate alanlarını kullanır', () => {
  const rows = validateCollectApiPayload(
    collectPayload([
      liveProduct('Çeyrek Altın Eski', 10_900.75, 11_050.5, { rate: 0.76 }),
      liveProduct('Yarım Altın Eski', 21_800.5, 22_100.25, { rate: -0.38 }),
      liveProduct('Tam Altın Eski', 43_600.75, 44_200.5, { rate: 0 }),
    ]),
  );
  assert.deepEqual(
    rows.map((row) => [
      row.code,
      row.buy,
      row.sell,
      row.price,
      row.reference,
      row.change,
      row.changePercent,
    ]),
    [
      ['CEYREK_ESKI', 10_900.75, 11_050.5, 11_050.5, 11_050.5, null, 0.76],
      ['YARIM_ESKI', 21_800.5, 22_100.25, 22_100.25, 22_100.25, null, -0.38],
      ['TAM_ESKI', 43_600.75, 44_200.5, 44_200.5, 44_200.5, null, 0],
    ],
  );
});

test('geçersiz rate satır fiyatlarını etkilemeden changePercent değerini null bırakır', () => {
  const [row] = validateCollectApiPayload(
    collectPayload([
      liveProduct('Çeyrek Altın', 11_004.81, 11_179.93, { rate: 'abc' }),
    ]),
  );
  assert.equal(row.buy, 11_004.81);
  assert.equal(row.sell, 11_179.93);
  assert.equal(row.change, null);
  assert.equal(row.changePercent, null);
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
