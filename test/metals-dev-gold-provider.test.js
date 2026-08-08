const assert = require('node:assert/strict');
const test = require('node:test');
const {
  GoldPriceUnavailableError,
  MAX_TRY_PER_TROY_OUNCE,
  MetalsDevDataError,
  MetalsDevGoldProvider,
  TROY_OUNCE_GRAMS,
  parseRetryAfter,
  validateSpotPayload,
} = require('../services/metals-dev-gold-provider');

const BASE_NOW = Date.parse('2026-08-03T10:00:30.000Z');
const TEST_KEY = 'test-placeholder-key';

function spotPayload(overrides = {}) {
  const rate = {
    price: 200_000,
    bid: 199_900,
    ask: 200_100,
    high: 201_000,
    low: 198_500,
    change: -500,
    change_percent: -0.25,
    ...(overrides.rate || {}),
  };
  return {
    status: 'success',
    timestamp: '2026-08-03T10:00:00.000Z',
    currency: 'TRY',
    unit: 'toz',
    metal: 'gold',
    ...overrides,
    rate,
  };
}

function jsonResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status || 200,
    headers: options.headers,
  });
}

function provider(options = {}) {
  return new MetalsDevGoldProvider({
    apiKey: TEST_KEY,
    now: () => BASE_NOW,
    staleMaxAgeMs: 300_000,
    fetchImpl: async () => jsonResponse(spotPayload()),
    ...options,
  });
}

test('geçerli nested Metals.dev spot yanıtını rows contractına dönüştürür', async () => {
  let requestedUrl;
  const instance = provider({
    fetchImpl: async (url) => {
      requestedUrl = url;
      return jsonResponse(spotPayload());
    },
  });

  const payload = await instance.getPrices();
  const gram = payload.rows.find((row) => row.code === 'GRAM');
  const ounce = payload.rows.find((row) => row.code === 'ONS');

  assert.equal(requestedUrl.origin, 'https://api.metals.dev');
  assert.equal(requestedUrl.pathname, '/v1/metal/spot');
  assert.equal(requestedUrl.searchParams.get('metal'), 'gold');
  assert.equal(requestedUrl.searchParams.get('currency'), 'TRY');
  assert.equal(payload.source, 'Metals.dev');
  assert.equal(payload.sourceType, 'spot');
  assert.equal(payload.sourceTimestamp, '2026-08-03T10:00:00.000Z');
  assert.equal(gram.reference, Number((200_000 / TROY_OUNCE_GRAMS).toFixed(4)));
  assert.equal(gram.buy, Number((199_900 / TROY_OUNCE_GRAMS).toFixed(4)));
  assert.equal(gram.sell, Number((200_100 / TROY_OUNCE_GRAMS).toFixed(4)));
  assert.equal(gram.change, Number((-500 / TROY_OUNCE_GRAMS).toFixed(4)));
  assert.equal(gram.changePercent, -0.25);
  assert.equal(ounce.reference, 200_000);
  assert.equal(ounce.currency, 'TRY');
});

test('eksik, NaN, Infinity, sıfır, negatif ve aşırı rate.price değerlerini reddeder', () => {
  for (const price of [undefined, NaN, Infinity, 0, -1, MAX_TRY_PER_TROY_OUNCE + 1]) {
    const payload = spotPayload({ rate: { price } });
    assert.throws(
      () => validateSpotPayload(payload, { nowMs: BASE_NOW }),
      MetalsDevDataError,
    );
  }
});

test('geçersiz bid ve ask alanlarını reddeder, eksik opsiyonel alanı null yapar', () => {
  for (const rate of [{ bid: NaN }, { bid: -1 }, { ask: Infinity }, { ask: 0 }]) {
    assert.throws(
      () => validateSpotPayload(spotPayload({ rate }), { nowMs: BASE_NOW }),
      MetalsDevDataError,
    );
  }
  const valid = validateSpotPayload(
    spotPayload({ rate: { bid: null, ask: null, high: null, low: null } }),
    { nowMs: BASE_NOW },
  );
  assert.equal(valid.bid, null);
  assert.equal(valid.ask, null);
  assert.equal(valid.high, null);
  assert.equal(valid.low, null);
});

test('timestamp, currency, metal ve unit alanlarını kesin doğrular', () => {
  const cases = [
    { timestamp: 'not-a-date' },
    { timestamp: '2026-08-03' },
    { currency: 'USD' },
    { metal: 'silver' },
    { unit: 'g' },
  ];
  for (const overrides of cases) {
    assert.throws(
      () => validateSpotPayload(spotPayload(overrides), { nowMs: BASE_NOW }),
      MetalsDevDataError,
    );
  }
});

test('HTTP 401 ve 403 yapılandırma hatalarında tekrar tekrar fetch yapmaz', async () => {
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

test('HTTP 429 Retry-After değerini uygular ve blok süresinde yeniden çağırmaz', async () => {
  let clock = BASE_NOW;
  let calls = 0;
  const instance = provider({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '120' } })
        : jsonResponse(spotPayload({ timestamp: new Date(clock - 30_000).toISOString() }));
    },
  });

  await assert.rejects(
    instance.getPrices(),
    (error) => error.retryAfterSeconds >= 120,
  );
  await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
  assert.equal(calls, 1);
  clock += 120_001;
  assert.equal((await instance.getPrices()).freshness, 'fresh');
  assert.equal(calls, 2);
});

test('Retry-After HTTP tarihini milisaniyeye çevirir', () => {
  assert.equal(
    parseRetryAfter('Mon, 03 Aug 2026 10:02:30 GMT', BASE_NOW),
    120_000,
  );
});

test('HTTP 500 ve cache yokken güvenli 503 üretir', async () => {
  const instance = provider({
    fetchImpl: async () => new Response('', { status: 500 }),
  });
  await assert.rejects(
    instance.getPrices(),
    (error) => error instanceof GoldPriceUnavailableError && error.statusCode === 503,
  );
});

test('timeout olduğunda cache yoksa 503 üretir', async () => {
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

test('Content-Length ile bildirilen aşırı büyük responseu reddeder', async () => {
  const instance = provider({
    maxResponseBytes: 64,
    fetchImpl: async () =>
      new Response('{}', { status: 200, headers: { 'content-length': '1000' } }),
  });
  await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
});

test('Content-Length olmadan stream edilen aşırı büyük responseu reddeder', async () => {
  const instance = provider({
    maxResponseBytes: 64,
    fetchImpl: async () => new Response('x'.repeat(1000), { status: 200 }),
  });
  await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
});

test('bozuk JSON yanıtını reddeder', async () => {
  const instance = provider({
    fetchImpl: async () => new Response('{broken', { status: 200 }),
  });
  await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
});

test('API key eksikliğinde fetch başlatmadan configuration 503 üretir', async () => {
  let calls = 0;
  const instance = provider({
    apiKey: '',
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(spotPayload());
    },
  });
  await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
  assert.equal(calls, 0);
  assert.equal(instance.status().configured, false);
});

test('cache hit harici çağrı yapmaz, expiry sonrası cache miss yeniler', async () => {
  let clock = BASE_NOW;
  let calls = 0;
  const instance = provider({
    now: () => clock,
    cacheTtlMs: 60_000,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(
        spotPayload({ timestamp: new Date(clock - 30_000).toISOString() }),
      );
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
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const instance = provider({
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return jsonResponse(spotPayload());
    },
  });
  const first = instance.getPrices();
  const second = instance.getPrices();
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(one, two);
});

test('başarılı son veriyi stale sınırı içinde korur', async () => {
  let clock = BASE_NOW;
  let calls = 0;
  const instance = provider({
    now: () => clock,
    cacheTtlMs: 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(spotPayload());
      }
      throw new Error('network unavailable');
    },
  });
  const fresh = await instance.getPrices();
  clock += 60_000;
  const stale = await instance.getPrices();
  assert.equal(fresh.freshness, 'fresh');
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.staleAgeSeconds, 90);
  assert.equal(stale.fetchedAt, fresh.fetchedAt);
});

test('last-known-good maksimum stale yaşı aşınca sunulmaz', async () => {
  let clock = BASE_NOW;
  let calls = 0;
  const instance = provider({
    now: () => clock,
    cacheTtlMs: 1,
    staleMaxAgeMs: 120_000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(spotPayload());
      }
      throw new Error('network unavailable');
    },
  });
  await instance.getPrices();
  clock += 120_001;
  await assert.rejects(instance.getPrices(), GoldPriceUnavailableError);
});

test('Çeyrek ve Cumhuriyet satırlarını yalnızca theoretical üretir', async () => {
  const payload = await provider().getPrices();
  for (const code of ['CEYREK', 'CUMHURIYET']) {
    const row = payload.rows.find((item) => item.code === code);
    assert.equal(row.type, 'theoretical');
    assert.equal(row.isEstimated, true);
    assert.equal(row.buy, null);
    assert.equal(row.sell, null);
  }
});

test('API key response veya güvenli hata mesajına sızmaz', async () => {
  const success = await provider().getPrices();
  assert.equal(JSON.stringify(success).includes(TEST_KEY), false);

  const failed = provider({
    fetchImpl: async () => new Response('', { status: 500 }),
  });
  await assert.rejects(
    failed.getPrices(),
    (error) => !String(error.message).includes(TEST_KEY),
  );
});
