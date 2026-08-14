const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CombinedGoldProvider,
  TARGET_PRODUCTS,
} = require('../services/combined-gold-provider');
const {
  GoldPriceUnavailableError,
} = require('../services/metals-dev-gold-provider');
const {
  createAppServer,
  createPriceProvider,
  providerStatus,
} = require('../server');

const TARGET_CODES = [
  'GRAM',
  'ONS',
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
];

function row(code, value, type) {
  return {
    code,
    name: `external-${code}`,
    description: '<external>',
    type,
    price: value,
    reference: value,
    buy: value - 1,
    sell: value + 1,
    change: 2,
    changePercent: 0.5,
    currency: 'TRY',
    isEstimated: false,
  };
}

function payload(source, sourceType, rows, overrides = {}) {
  return {
    source,
    sourceType,
    sourceTimestamp: '2026-08-12T11:59:00.000Z',
    fetchedAt: '2026-08-12T12:00:00.000Z',
    freshness: 'fresh',
    rows,
    ...overrides,
  };
}

function stubProvider(name, result, configured = true) {
  return {
    isConfigured: () => configured,
    status: () => ({ provider: name, configured, blockedUntil: null }),
    getPrices: async () => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

function combined(metalsResult, collectResult, options = {}) {
  return new CombinedGoldProvider({
    metalsProvider: stubProvider(
      'metals_dev',
      metalsResult,
      options.metalsConfigured,
    ),
    collectProvider: stubProvider(
      'collectapi',
      collectResult,
      options.collectConfigured,
    ),
  });
}

function metalsPayload(overrides = {}) {
  return payload(
    'Metals.dev',
    'spot',
    [
      row('GRAM', 4_500, 'spot'),
      row('ONS', 140_000, 'spot'),
      row('CEYREK', 99_999, 'theoretical'),
    ],
    overrides,
  );
}

function collectPayload(overrides = {}) {
  return payload(
    'CollectAPI',
    'market',
    [
      row('CEYREK', 7_500, 'market'),
      row('CEYREK_ESKI', 7_400, 'market'),
      row('YARIM', 15_000, 'market'),
      row('YARIM_ESKI', 14_800, 'market'),
      row('TAM', 30_000, 'market'),
      row('TAM_ESKI', 29_600, 'market'),
      row('CUMHURIYET', 31_000, 'market'),
      row('ATA', 31_500, 'market'),
      row('RESAT', 32_000, 'market'),
      row('ALTIN_22', 4_100, 'market'),
      row('GRAM', 1, 'market'),
    ],
    overrides,
  );
}

test('on iki hedef ürünü sabit sırada ve doğru provider verisiyle birleştirir', async () => {
  const result = await combined(metalsPayload(), collectPayload()).getPrices();
  assert.deepEqual(result.rows.map((item) => item.code), TARGET_CODES);
  assert.deepEqual(TARGET_PRODUCTS.map((item) => item.code), TARGET_CODES);
  assert.equal(result.rows.length, 12);
  assert.equal(result.rows.find((item) => item.code === 'GRAM').reference, 4_500);
  assert.equal(result.rows.find((item) => item.code === 'CEYREK').reference, 7_500);
  assert.equal(result.rows.every((item) => item.isEstimated === false), true);
  assert.equal(result.source, 'Metals.dev + CollectAPI');
  assert.equal(result.sourceType, 'mixed');
  assert.equal(result.freshness, 'fresh');
});

test('harici ürün adlarını UI contractına taşımadan sade canonical isimler üretir', async () => {
  const result = await combined(metalsPayload(), collectPayload()).getPrices();
  assert.deepEqual(
    result.rows.map((item) => item.name),
    [
      'Gram Altın',
      'Ons Altın',
      'Çeyrek Altın',
      'Eski Çeyrek Altın',
      'Yarım Altın',
      'Eski Yarım Altın',
      'Tam Altın',
      'Eski Tam Altın',
      'Cumhuriyet Altını',
      'Ata Altın',
      'Reşat Altını',
      '22 Ayar Bilezik',
    ],
  );
  assert.equal(JSON.stringify(result).includes('<external>'), false);
});

test('CollectAPI başarısızsa spot satırları korunur ve fiziksel fiyatlar null kalır', async () => {
  const result = await combined(
    metalsPayload(),
    new GoldPriceUnavailableError(),
  ).getPrices();
  assert.equal(result.freshness, 'partial');
  assert.equal(result.rows.find((item) => item.code === 'GRAM').reference, 4_500);
  for (const code of TARGET_CODES.slice(2)) {
    const target = result.rows.find((item) => item.code === code);
    assert.equal(target.buy, null);
    assert.equal(target.sell, null);
    assert.equal(target.reference, null);
    assert.equal(target.isEstimated, false);
  }
  assert.equal(result.providers.collectApi.available, false);
});

test('Metals.dev başarısızsa fiziksel CollectAPI satırları korunur', async () => {
  const result = await combined(
    new GoldPriceUnavailableError(),
    collectPayload(),
  ).getPrices();
  assert.equal(result.freshness, 'partial');
  assert.equal(result.rows.find((item) => item.code === 'GRAM').reference, null);
  assert.equal(result.rows.find((item) => item.code === 'ONS').reference, null);
  assert.equal(result.rows.find((item) => item.code === 'YARIM').reference, 15_000);
  assert.equal(result.rows.find((item) => item.code === 'YARIM_ESKI').reference, 14_800);
  assert.equal(result.providers.metalsDev.available, false);
});

test('iki provider da başarısızsa güvenli 503 hatası üretir', async () => {
  const instance = combined(
    new GoldPriceUnavailableError(undefined, { retryAfterSeconds: 120 }),
    new GoldPriceUnavailableError(undefined, { retryAfterSeconds: 60 }),
  );
  await assert.rejects(
    instance.getPrices(),
    (error) =>
      error instanceof GoldPriceUnavailableError &&
      error.statusCode === 503 &&
      error.retryAfterSeconds === 60,
  );
});

test('stale provider satırlarında değişim üretmez ve provider metadata korunur', async () => {
  const result = await combined(
    metalsPayload({ freshness: 'stale', staleAgeSeconds: 75 }),
    collectPayload(),
  ).getPrices();
  const gram = result.rows.find((item) => item.code === 'GRAM');
  const quarter = result.rows.find((item) => item.code === 'CEYREK');
  assert.equal(result.freshness, 'stale');
  assert.equal(result.staleAgeSeconds, 75);
  assert.equal(gram.change, null);
  assert.equal(gram.changePercent, null);
  assert.equal(quarter.change, 2);
  assert.equal(result.providers.metalsDev.freshness, 'stale');
  assert.equal(result.providers.collectApi.freshness, 'fresh');
});

test('eksik tek ürün için tahmini veya yapay fiyat üretmez', async () => {
  const physical = collectPayload();
  physical.rows = physical.rows.filter((item) => item.code !== 'RESAT');
  const result = await combined(metalsPayload(), physical).getPrices();
  const resat = result.rows.find((item) => item.code === 'RESAT');
  assert.deepEqual(
    [resat.buy, resat.sell, resat.price, resat.reference, resat.change],
    [null, null, null, null, null],
  );
});

test('status yalnızca güvenli alt-provider durumlarını dışa açar', () => {
  const instance = combined(metalsPayload(), collectPayload());
  assert.deepEqual(providerStatus(instance), {
    provider: 'combined',
    configured: true,
    blockedUntil: null,
    providers: {
      metalsDev: {
        provider: 'metals_dev',
        configured: true,
        blockedUntil: null,
      },
      collectApi: {
        provider: 'collectapi',
        configured: true,
        blockedUntil: null,
      },
    },
  });
});

test('varsayılan server factory birleşik provider oluşturur ve anahtarları statusa sızdırmaz', () => {
  const instance = createPriceProvider(
    {
      NODE_ENV: 'test',
      GOLD_PROVIDER: 'metals_dev',
      METALS_DEV_API_KEY: 'TEST_METALS_SECRET',
      COLLECTAPI_TOKEN: 'TEST_COLLECT_SECRET',
    },
    {
      metalsDev: { fetchImpl: async () => new Response('', { status: 500 }) },
      collectApi: { fetchImpl: async () => new Response('', { status: 500 }) },
    },
  );
  const serialized = JSON.stringify(providerStatus(instance));
  assert.equal(instance instanceof CombinedGoldProvider, true);
  assert.equal(serialized.includes('TEST_METALS_SECRET'), false);
  assert.equal(serialized.includes('TEST_COLLECT_SECRET'), false);
});

test('tek provider yapılandırılması partial-ready kabul edilir', () => {
  const instance = combined(metalsPayload(), collectPayload(), {
    metalsConfigured: true,
    collectConfigured: false,
  });
  assert.equal(instance.isConfigured(), true);
  assert.equal(instance.status().configured, true);
});

test('/api/prices birleşik metadata ve on iki satırı token sızdırmadan döndürür', async () => {
  const nowMs = Date.parse('2026-08-12T12:00:00.000Z');
  const metalsSecret = 'TEST_HTTP_METALS_SECRET';
  const collectSecret = 'TEST_HTTP_COLLECT_SECRET';
  const server = createAppServer({
    env: {
      NODE_ENV: 'test',
      GOLD_PROVIDER: 'metals_dev',
      METALS_DEV_API_KEY: metalsSecret,
      COLLECTAPI_TOKEN: collectSecret,
    },
    providerOptions: {
      metalsDev: {
        now: () => nowMs,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              status: 'success',
              currency: 'TRY',
              metal: 'gold',
              unit: 'toz',
              timestamp: '2026-08-12T11:59:30.000Z',
              rate: {
                price: 140_000,
                bid: 139_900,
                ask: 140_100,
                change: 100,
                change_percent: 0.2,
              },
            }),
            { status: 200 },
          ),
      },
      collectApi: {
        now: () => nowMs,
        fetchImpl: async () =>
          new Response(JSON.stringify({ success: true, result: allPhysicalRows() }), {
            status: 200,
          }),
      },
    },
    getNews: async () => ({ source: 'test', items: [] }),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/prices`,
    );
    const text = await response.text();
    const result = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.deepEqual(result.rows.map((item) => item.code), TARGET_CODES);
    assert.equal(result.providers.metalsDev.source, 'Metals.dev');
    assert.equal(result.providers.collectApi.source, 'CollectAPI');
    assert.equal(result.sourceTimestamp, '2026-08-12T11:59:45.000Z');
    assert.deepEqual(
      result.rows
        .filter((item) => item.code === 'CEYREK')
        .map((item) => [item.buy, item.sell, item.price, item.change, item.changePercent]),
      [[7_100, 7_200, 7_200, null, 1.27]],
    );
    assert.deepEqual(
      result.rows
        .filter((item) => item.code.endsWith('_ESKI'))
        .map((item) => [
          item.code,
          item.buy,
          item.sell,
          item.price,
          item.reference,
          item.change,
          item.changePercent,
        ]),
      [
        ['CEYREK_ESKI', 7_000, 7_100, 7_100, 7_100, null, 0.76],
        ['YARIM_ESKI', 14_000, 14_200, 14_200, 14_200, null, -0.38],
        ['TAM_ESKI', 28_000, 28_400, 28_400, 28_400, null, 0],
      ],
    );
    assert.deepEqual(
      result.rows
        .filter((item) => item.code === 'GRAM' || item.code === 'ONS')
        .map((item) => [item.code, item.change, item.changePercent]),
      [
        ['GRAM', 3.2151, 0.2],
        ['ONS', 100, 0.2],
      ],
    );
    assert.equal(
      result.rows.find((item) => item.code === 'ALTIN_22').name,
      '22 Ayar Bilezik',
    );
    assert.equal(text.includes(metalsSecret), false);
    assert.equal(text.includes(collectSecret), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function allPhysicalRows() {
  return [
    livePhysicalRow('Çeyrek Altın', 7_100, 7_200),
    livePhysicalRow('Çeyrek Altın Eski', 7_000, 7_100, 0.76),
    livePhysicalRow('Yarım Altın', 14_200, 14_400),
    livePhysicalRow('Yarım Altın Eski', 14_000, 14_200, -0.38),
    livePhysicalRow('Tam Altın', 28_400, 28_800),
    livePhysicalRow('Tam Altın Eski', 28_000, 28_400, 0),
    livePhysicalRow('Cumhuriyet Altını', 29_000, 29_500),
    livePhysicalRow('Ata Altın', 29_200, 29_700),
    livePhysicalRow('Reşat Lira Altın', 29_400, 29_900),
    livePhysicalRow('22 Ayar Bilezik', 4_050, 4_110),
  ];
}

function livePhysicalRow(name, buying, selling, rate = 1.27) {
  return {
    name,
    buying,
    buyingstr: String(buying),
    selling,
    sellingstr: String(selling),
    time: '11:59:45',
    date: '2026-08-12',
    datetime: '2026-08-12T11:59:45.000Z',
    rate,
  };
}
