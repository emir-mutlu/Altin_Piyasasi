const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BistDataError,
  BistGoldProvider,
  DARPHANE_PRODUCTS,
  PriceUnavailableError,
  buildPricePayload,
  calculateChange,
  calculateGramReference,
  calculateTheoreticalValue,
  parseBistMetalXml,
  parseTurkishNumber,
} = require('../services/bist-gold-provider');

function sampleXml({
  date = '31.07.2026',
  tryGold = '6.202.704,30',
  usdGold = '4.056,78',
  eurGold = '3.536,60',
} = {}) {
  return `<?xml version="1.0" encoding="utf-8"?>
    <IGE>
      <IGE_GUN><gun>${date}</gun></IGE_GUN>
      <TL><altindeger>${tryGold}</altindeger></TL>
      <DOLAR><altindeger>${usdGold}</altindeger></DOLAR>
      <EURO><altindeger>${eurGold}</altindeger></EURO>
    </IGE>`;
}

function xmlResponse(xml) {
  return {
    ok: true,
    status: 200,
    text: async () => xml,
  };
}

test('Türkçe sayı biçimini doğru ayrıştırır', () => {
  assert.equal(parseTurkishNumber('6.113.254,93'), 6113254.93);
});

test('TRY/KG değerini gram referans fiyatına çevirir', () => {
  assert.equal(calculateGramReference('6.202.704,30'), 6202.7043);
});

test('karşılaştırılabilir önceki değer varsa yüzde değişimi doğru hesaplar', () => {
  assert.equal(calculateChange(105, 100), 5);
  assert.equal(calculateChange(95, 100), -5);
  assert.equal(calculateChange(100, null), null);
});

test('bozuk XML verisini reddeder', () => {
  assert.throws(
    () => parseBistMetalXml('<IGE><TL><altindeger>10</altindeger></IGE>'),
    BistDataError,
  );
});

test('altın TRY/KG alanı eksik olduğunda veriyi reddeder', () => {
  const xml = `<?xml version="1.0"?><IGE>
    <IGE_GUN><gun>31.07.2026</gun></IGE_GUN>
    <TL><gumusdeger>88.000,00</gumusdeger></TL>
  </IGE>`;

  assert.throws(() => parseBistMetalXml(xml), BistDataError);
});

test('harici istek zaman aşımında cache yoksa 503 hatası üretir', async () => {
  const provider = new BistGoldProvider({
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
  });

  await assert.rejects(
    provider.getPrices(),
    (error) => error instanceof PriceUnavailableError && error.statusCode === 503,
  );
});

test('yeni istek başarısızsa son başarılı veriyi stale olarak döndürür', async () => {
  let clock = Date.parse('2026-07-31T12:00:00Z');
  let requestCount = 0;
  const provider = new BistGoldProvider({
    cacheTtlMs: 1,
    now: () => clock,
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return xmlResponse(sampleXml());
      }
      throw new Error('network unavailable');
    },
  });

  const first = await provider.getPrices();
  clock += 2;
  const fallback = await provider.getPrices();
  const cachedFallback = await provider.getPrices();

  assert.equal(first.freshness, 'fresh');
  assert.equal(fallback.freshness, 'stale');
  assert.equal(cachedFallback.freshness, 'stale');
  assert.equal(fallback.warning, 'Veri geçici olarak güncellenemedi.');
  assert.equal(fallback.fetchedAt, first.fetchedAt);
  assert.deepEqual(fallback.rows, first.rows);
  assert.equal(requestCount, 2);
});

test('kaynak tarihi yaş sınırını aşmış veriyi stale işaretler', () => {
  const snapshot = parseBistMetalXml(sampleXml({ date: '01.07.2026' }));
  const now = Date.parse('2026-07-10T12:00:00Z');
  const payload = buildPricePayload(
    snapshot,
    null,
    new Date(now).toISOString(),
    now,
    96 * 60 * 60 * 1000,
  );

  assert.equal(payload.freshness, 'stale');
  assert.match(payload.warning, /kaynak tarihi/i);
});

test('Çeyrek Ziynet ile Birlik Ziynet ve ATA/Sikke ağırlıklarını karıştırmaz', () => {
  const gramReference = 1000;
  const quarter = calculateTheoreticalValue(
    gramReference,
    DARPHANE_PRODUCTS.CEYREK_ZIYNET,
  );
  const unityZiynet = calculateTheoreticalValue(
    gramReference,
    DARPHANE_PRODUCTS.BIRLIK_ZIYNET,
  );
  const unityCoin = calculateTheoreticalValue(
    gramReference,
    DARPHANE_PRODUCTS.BIRLIK_SIKKE,
  );

  assert.equal(quarter, 1607.72);
  assert.equal(unityZiynet, 6430.87);
  assert.equal(unityCoin, 6614.19);
  assert.ok(unityCoin > unityZiynet);
});

test('alış, satış ve karşılaştırmasız değişim üretmez', () => {
  const snapshot = parseBistMetalXml(sampleXml());
  const now = Date.parse('2026-07-31T12:00:00Z');
  const payload = buildPricePayload(
    snapshot,
    null,
    new Date(now).toISOString(),
    now,
    96 * 60 * 60 * 1000,
  );

  for (const row of payload.rows) {
    assert.equal(row.buy, null);
    assert.equal(row.sell, null);
    assert.equal(row.change, null);
  }
});
