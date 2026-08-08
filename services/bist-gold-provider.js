const { XMLParser, XMLValidator } = require('fast-xml-parser');

const SOURCE_NAME = 'Borsa İstanbul KMKTP';
const SOURCE_TYPE = 'official_reference';
const DEFAULT_BIST_METAL_XML_URL =
  'https://www.borsaistanbul.com/metal-fiyatlari.php?op=generateMetalFiyatlariXML&lang=tr';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_SOURCE_AGE_MS = 96 * 60 * 60 * 1000;

const DARPHANE_PRODUCTS = Object.freeze({
  CEYREK_ZIYNET: Object.freeze({
    code: 'CEYREK',
    name: 'Çeyrek Ziynet',
    grossWeightGrams: 1.754,
    purity: 0.9166,
  }),
  BIRLIK_ZIYNET: Object.freeze({
    code: 'CUMHURIYET',
    name: 'Birlik Cumhuriyet Ziynet',
    grossWeightGrams: 7.016,
    purity: 0.9166,
  }),
  BIRLIK_SIKKE: Object.freeze({
    code: 'ATA',
    name: 'ATA / Cumhuriyet Sikke',
    grossWeightGrams: 7.216,
    purity: 0.9166,
  }),
});

const xmlParser = new XMLParser({
  allowBooleanAttributes: false,
  ignoreAttributes: true,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
});

class BistDataError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'BistDataError';
  }
}

class PriceUnavailableError extends Error {
  constructor(message = 'Borsa İstanbul fiyat verisi şu anda kullanılamıyor.', options = {}) {
    super(message, options);
    this.name = 'PriceUnavailableError';
    this.statusCode = 503;
  }
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTurkishNumber(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BistDataError('Fiyat sayısal ve sonlu olmalıdır.');
    }
    return value;
  }

  if (typeof value !== 'string') {
    throw new BistDataError('Fiyat metin veya sayı olmalıdır.');
  }

  const compact = value.replace(/[\s\u00a0]/g, '').trim();
  const turkishNumberPattern = /^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;

  if (!turkishNumberPattern.test(compact)) {
    throw new BistDataError(`Geçersiz Türkçe sayı biçimi: ${value}`);
  }

  const parsed = Number(compact.replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(parsed)) {
    throw new BistDataError('Fiyat sayısal ve sonlu olmalıdır.');
  }

  return parsed;
}

function requirePositivePrice(value, fieldName) {
  const parsed = parseTurkishNumber(value);
  if (parsed <= 0) {
    throw new BistDataError(`${fieldName} sıfırdan büyük olmalıdır.`);
  }
  return parsed;
}

function parseTurkishDate(value) {
  const match = String(value || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) {
    throw new BistDataError('Borsa İstanbul kaynak tarihi geçersiz.');
  }

  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const verificationDate = new Date(Date.UTC(year, month - 1, day));

  if (
    verificationDate.getUTCFullYear() !== year ||
    verificationDate.getUTCMonth() !== month - 1 ||
    verificationDate.getUTCDate() !== day
  ) {
    throw new BistDataError('Borsa İstanbul kaynak tarihi geçersiz.');
  }

  const isoDate = new Date(`${yearText}-${monthText}-${dayText}T00:00:00+03:00`);
  return {
    label: `${dayText}.${monthText}.${yearText}`,
    date: `${yearText}-${monthText}-${dayText}`,
    timestamp: isoDate.toISOString(),
  };
}

function parseBistMetalXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new BistDataError('Borsa İstanbul XML verisi boş.');
  }

  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new BistDataError('DTD veya entity içeren XML kabul edilmez.');
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new BistDataError('Borsa İstanbul XML verisi bozuk.');
  }

  let parsed;
  try {
    parsed = xmlParser.parse(xml);
  } catch (error) {
    throw new BistDataError('Borsa İstanbul XML verisi ayrıştırılamadı.', {
      cause: error,
    });
  }

  const root = parsed?.IGE;
  if (!root || typeof root !== 'object') {
    throw new BistDataError('Borsa İstanbul XML kök alanı eksik.');
  }

  const sourceDate = parseTurkishDate(root.IGE_GUN?.gun);
  const tryPerKg = requirePositivePrice(
    root.TL?.altindeger,
    'Altın TRY/KG değeri',
  );
  const usdPerOunce = root.DOLAR?.altindeger
    ? requirePositivePrice(root.DOLAR.altindeger, 'Altın USD/ONS değeri')
    : null;
  const eurPerOunce = root.EURO?.altindeger
    ? requirePositivePrice(root.EURO.altindeger, 'Altın EUR/ONS değeri')
    : null;

  return {
    sourceDate: sourceDate.date,
    sourceDateLabel: sourceDate.label,
    sourceTimestamp: sourceDate.timestamp,
    tryPerKg,
    usdPerOunce,
    eurPerOunce,
  };
}

function calculateGramReference(tryPerKg) {
  const value = requirePositivePrice(tryPerKg, 'Altın TRY/KG değeri') / 1000;
  return Number(value.toFixed(4));
}

function calculateTheoreticalValue(gramReference, product) {
  const gramValue = requirePositivePrice(gramReference, 'Gram referans fiyatı');
  if (!product || !Number.isFinite(product.grossWeightGrams) || !Number.isFinite(product.purity)) {
    throw new BistDataError('Darphane ürün bilgisi geçersiz.');
  }

  return Number(
    (gramValue * product.grossWeightGrams * product.purity).toFixed(2),
  );
}

function calculateChange(current, previous) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    current <= 0 ||
    previous <= 0
  ) {
    return null;
  }

  return Number((((current - previous) / previous) * 100).toFixed(2));
}

function applyComparableChanges(rows, previousPayload, sourceDate) {
  if (
    !previousPayload?.sourceDate ||
    Date.parse(previousPayload.sourceDate) >= Date.parse(sourceDate)
  ) {
    return rows.map((row) => ({ ...row, change: null }));
  }

  const previousRows = new Map(
    (previousPayload.rows || []).map((row) => [row.code, row]),
  );

  return rows.map((row) => ({
    ...row,
    change: calculateChange(
      row.reference,
      previousRows.get(row.code)?.reference,
    ),
  }));
}

function sourceFreshness(sourceDate, nowMs, maxSourceAgeMs) {
  const sourceTime = /^\d{4}-\d{2}-\d{2}$/.test(sourceDate)
    ? Date.parse(`${sourceDate}T00:00:00+03:00`)
    : Date.parse(sourceDate);
  const age = nowMs - sourceTime;
  return Number.isFinite(sourceTime) && age >= 0 && age <= maxSourceAgeMs
    ? 'fresh'
    : 'stale';
}

function buildRows(snapshot) {
  const gramReference = calculateGramReference(snapshot.tryPerKg);
  const quarter = DARPHANE_PRODUCTS.CEYREK_ZIYNET;
  const unityZiynet = DARPHANE_PRODUCTS.BIRLIK_ZIYNET;
  const unityCoin = DARPHANE_PRODUCTS.BIRLIK_SIKKE;

  const rows = [
    {
      code: 'GRAM',
      name: 'Gram Altın',
      description: 'Borsa İstanbul referans gram fiyatı',
      buy: null,
      sell: null,
      reference: Number(gramReference.toFixed(2)),
      currency: 'TRY',
      isEstimated: false,
      featured: true,
    },
    {
      code: quarter.code,
      name: quarter.name,
      description: 'Teorik · 1,754 g · 916,6 milyem',
      buy: null,
      sell: null,
      reference: calculateTheoreticalValue(gramReference, quarter),
      currency: 'TRY',
      isEstimated: true,
      featured: true,
    },
    {
      code: unityZiynet.code,
      name: unityZiynet.name,
      description: 'Teorik · 7,016 g · 916,6 milyem',
      buy: null,
      sell: null,
      reference: calculateTheoreticalValue(gramReference, unityZiynet),
      currency: 'TRY',
      isEstimated: true,
      featured: true,
    },
    {
      code: unityCoin.code,
      name: unityCoin.name,
      description: 'Teorik · 7,216 g · 916,6 milyem',
      buy: null,
      sell: null,
      reference: calculateTheoreticalValue(gramReference, unityCoin),
      currency: 'TRY',
      isEstimated: true,
      featured: false,
    },
  ];

  if (snapshot.usdPerOunce) {
    rows.push({
      code: 'ONS',
      name: 'Ons Altın',
      description: 'Borsa İstanbul metal fiyatı · USD/ONS',
      buy: null,
      sell: null,
      reference: Number(snapshot.usdPerOunce.toFixed(2)),
      currency: 'USD',
      isEstimated: false,
      featured: false,
    });
  }

  return rows;
}

function buildPricePayload(snapshot, previousPayload, fetchedAt, nowMs, maxSourceAgeMs) {
  const rows = applyComparableChanges(
    buildRows(snapshot),
    previousPayload,
    snapshot.sourceDate,
  );
  const freshness = sourceFreshness(
    snapshot.sourceDate,
    nowMs,
    maxSourceAgeMs,
  );

  return {
    source: SOURCE_NAME,
    sourceType: SOURCE_TYPE,
    sourceDate: snapshot.sourceDate,
    sourceDateLabel: snapshot.sourceDateLabel,
    fetchedAt,
    updatedAt: snapshot.sourceTimestamp,
    freshness,
    isEstimated: rows.some((row) => row.isEstimated),
    disclaimer:
      'Resmi Borsa İstanbul metal referans verisidir; perakende kuyumcu alış/satış fiyatı değildir.',
    ...(freshness === 'stale'
      ? { warning: 'Borsa İstanbul kaynak tarihi güncel değil.' }
      : {}),
    rows,
  };
}

function refreshPayloadFreshness(payload, nowMs, maxSourceAgeMs) {
  if (payload.error) {
    return { ...payload, freshness: 'stale' };
  }

  const freshness = sourceFreshness(
    payload.sourceDate,
    nowMs,
    maxSourceAgeMs,
  );
  const next = { ...payload, freshness };

  if (freshness === 'stale' && !next.warning) {
    next.warning = 'Borsa İstanbul kaynak tarihi güncel değil.';
  }

  if (freshness === 'fresh' && next.warning === 'Borsa İstanbul kaynak tarihi güncel değil.') {
    delete next.warning;
  }

  return next;
}

class BistGoldProvider {
  constructor(options = {}) {
    this.xmlUrl =
      options.xmlUrl ||
      process.env.BIST_METAL_XML_URL ||
      DEFAULT_BIST_METAL_XML_URL;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.cacheTtlMs = readPositiveNumber(
      options.cacheTtlMs ?? process.env.BIST_PRICE_CACHE_TTL_MS,
      DEFAULT_CACHE_TTL_MS,
    );
    this.timeoutMs = readPositiveNumber(
      options.timeoutMs ?? process.env.BIST_XML_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    );
    this.maxSourceAgeMs = readPositiveNumber(
      options.maxSourceAgeMs ??
        (process.env.BIST_SOURCE_MAX_AGE_HOURS
          ? Number(process.env.BIST_SOURCE_MAX_AGE_HOURS) * 60 * 60 * 1000
          : undefined),
      DEFAULT_MAX_SOURCE_AGE_MS,
    );
    this.now = options.now || (() => Date.now());
    this.cache = null;
    this.lastKnownGood = null;
    this.inFlight = null;

    if (typeof this.fetchImpl !== 'function') {
      throw new BistDataError('Fetch desteği bulunamadı. Node.js 18 veya üzeri gerekir.');
    }
  }

  async fetchXml() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.xmlUrl, {
        headers: {
          accept: 'application/xml, text/xml',
          'user-agent': 'altinpiyasasi.com official BIST reference client',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new BistDataError(
          `Borsa İstanbul XML isteği başarısız: HTTP ${response.status}`,
        );
      }

      return await response.text();
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new BistDataError('Borsa İstanbul XML isteği zaman aşımına uğradı.', {
          cause: error,
        });
      }
      if (error instanceof BistDataError) {
        throw error;
      }
      throw new BistDataError('Borsa İstanbul XML verisi alınamadı.', {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async refresh() {
    const nowMs = this.now();
    const fetchedAt = new Date(nowMs).toISOString();
    const snapshot = parseBistMetalXml(await this.fetchXml());
    const payload = buildPricePayload(
      snapshot,
      this.lastKnownGood,
      fetchedAt,
      nowMs,
      this.maxSourceAgeMs,
    );

    this.lastKnownGood = payload;
    this.cache = {
      expiresAt: nowMs + this.cacheTtlMs,
      payload,
    };

    return payload;
  }

  async getPrices() {
    const nowMs = this.now();
    if (this.cache && nowMs < this.cache.expiresAt) {
      return refreshPayloadFreshness(
        this.cache.payload,
        nowMs,
        this.maxSourceAgeMs,
      );
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.refresh()
      .catch((error) => {
        if (this.lastKnownGood) {
          const stalePayload = {
            ...this.lastKnownGood,
            freshness: 'stale',
            warning: 'Veri geçici olarak güncellenemedi.',
            error: 'Borsa İstanbul verisi alınamadı.',
          };
          this.cache = {
            expiresAt: this.now() + Math.min(this.cacheTtlMs, 30_000),
            payload: stalePayload,
          };
          return stalePayload;
        }

        throw new PriceUnavailableError(undefined, { cause: error });
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }
}

module.exports = {
  BistDataError,
  BistGoldProvider,
  DARPHANE_PRODUCTS,
  DEFAULT_BIST_METAL_XML_URL,
  PriceUnavailableError,
  buildPricePayload,
  calculateChange,
  calculateGramReference,
  calculateTheoreticalValue,
  parseBistMetalXml,
  parseTurkishNumber,
  sourceFreshness,
};
