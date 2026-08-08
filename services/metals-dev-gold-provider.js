const {
  DARPHANE_PRODUCTS,
  calculateTheoreticalValue,
} = require('./bist-gold-provider');

const METALS_DEV_ORIGIN = 'https://api.metals.dev';
const METALS_DEV_SPOT_PATH = '/v1/metal/spot';
const TROY_OUNCE_GRAMS = 31.1034768;
const MAX_TRY_PER_TROY_OUNCE = 100_000_000;
const MAX_CHANGE_PERCENT = 100_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_STALE_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60_000;
const CONFIGURATION_BACKOFF_MS = 15 * 60 * 1000;
const MAX_TRANSIENT_BACKOFF_MS = 5 * 60 * 1000;

class MetalsDevDataError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'MetalsDevDataError';
    this.code = options.code || 'INVALID_PROVIDER_DATA';
    this.retryable = options.retryable !== false;
  }
}

class MetalsDevConfigurationError extends Error {
  constructor(message = 'Metals.dev yapılandırması eksik veya geçersiz.', options = {}) {
    super(message, options);
    this.name = 'MetalsDevConfigurationError';
    this.code = options.code || 'PROVIDER_CONFIGURATION_ERROR';
    this.statusCode = 503;
    this.retryable = false;
  }
}

class MetalsDevHttpError extends Error {
  constructor(status, options = {}) {
    super(`Metals.dev isteği HTTP ${status} durumuyla başarısız oldu.`);
    this.name = 'MetalsDevHttpError';
    this.code = options.code || 'PROVIDER_HTTP_ERROR';
    this.status = status;
    this.retryable = options.retryable !== false;
    this.retryAfterMs = options.retryAfterMs || null;
  }
}

class GoldPriceUnavailableError extends Error {
  constructor(message = 'Altın spot fiyatı şu anda kullanılamıyor.', options = {}) {
    super(message, options);
    this.name = 'GoldPriceUnavailableError';
    this.code = options.code || 'PRICE_UNAVAILABLE';
    this.statusCode = 503;
    this.retryAfterSeconds = options.retryAfterSeconds || null;
  }
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function requireFiniteNumber(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MetalsDevDataError(`${fieldName} sonlu bir sayı olmalıdır.`);
  }
  return value;
}

function requirePositiveRate(value, fieldName) {
  const parsed = requireFiniteNumber(value, fieldName);
  if (parsed <= 0 || parsed > MAX_TRY_PER_TROY_OUNCE) {
    throw new MetalsDevDataError(
      `${fieldName} sıfırdan büyük ve güvenli fiyat sınırı içinde olmalıdır.`,
    );
  }
  return parsed;
}

function optionalPositiveRate(value, fieldName) {
  return value === undefined || value === null
    ? null
    : requirePositiveRate(value, fieldName);
}

function optionalFiniteChange(value, fieldName, absoluteLimit) {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = requireFiniteNumber(value, fieldName);
  if (Math.abs(parsed) > absoluteLimit) {
    throw new MetalsDevDataError(`${fieldName} güvenli değer sınırını aşıyor.`);
  }
  return parsed;
}

function validateTimestamp(value, nowMs, staleMaxAgeMs) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new MetalsDevDataError('Metals.dev timestamp alanı geçerli ISO tarih olmalıdır.');
  }

  const timestampMs = Date.parse(value);
  const ageMs = nowMs - timestampMs;
  if (!Number.isFinite(timestampMs)) {
    throw new MetalsDevDataError('Metals.dev timestamp alanı geçersiz.');
  }
  if (ageMs < -MAX_FUTURE_SKEW_MS) {
    throw new MetalsDevDataError('Metals.dev timestamp alanı gelecekte.');
  }
  if (ageMs > staleMaxAgeMs) {
    throw new MetalsDevDataError('Metals.dev verisi izin verilen maksimum yaşı aşıyor.');
  }

  return new Date(timestampMs).toISOString();
}

function validateSpotPayload(payload, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const staleMaxAgeMs = readPositiveNumber(
    options.staleMaxAgeMs,
    DEFAULT_STALE_MAX_AGE_MS,
  );

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MetalsDevDataError('Metals.dev yanıtı bir JSON nesnesi olmalıdır.');
  }
  if (payload.status !== 'success') {
    throw new MetalsDevDataError('Metals.dev yanıt durumu success değil.');
  }
  if (payload.currency !== 'TRY') {
    throw new MetalsDevDataError('Metals.dev para birimi TRY olmalıdır.');
  }
  if (payload.metal !== 'gold') {
    throw new MetalsDevDataError('Metals.dev metal alanı gold olmalıdır.');
  }
  if (payload.unit !== 'toz') {
    throw new MetalsDevDataError('Metals.dev birimi toz olmalıdır.');
  }
  if (!payload.rate || typeof payload.rate !== 'object' || Array.isArray(payload.rate)) {
    throw new MetalsDevDataError('Metals.dev rate nesnesi eksik.');
  }

  return {
    timestamp: validateTimestamp(payload.timestamp, nowMs, staleMaxAgeMs),
    price: requirePositiveRate(payload.rate.price, 'rate.price'),
    bid: optionalPositiveRate(payload.rate.bid, 'rate.bid'),
    ask: optionalPositiveRate(payload.rate.ask, 'rate.ask'),
    high: optionalPositiveRate(payload.rate.high, 'rate.high'),
    low: optionalPositiveRate(payload.rate.low, 'rate.low'),
    change: optionalFiniteChange(
      payload.rate.change,
      'rate.change',
      MAX_TRY_PER_TROY_OUNCE,
    ),
    changePercent: optionalFiniteChange(
      payload.rate.change_percent,
      'rate.change_percent',
      MAX_CHANGE_PERCENT,
    ),
  };
}

function perGram(value) {
  return value === null ? null : round(value / TROY_OUNCE_GRAMS);
}

function buildSpotRows(snapshot) {
  const gramPrice = perGram(snapshot.price);
  const quarter = DARPHANE_PRODUCTS.CEYREK_ZIYNET;
  const unityZiynet = DARPHANE_PRODUCTS.BIRLIK_ZIYNET;
  const unityCoin = DARPHANE_PRODUCTS.BIRLIK_SIKKE;

  return [
    {
      code: 'GRAM',
      name: 'Gram Altın',
      description: 'Global spot · TRY/gram',
      type: 'spot',
      price: gramPrice,
      buy: perGram(snapshot.bid),
      sell: perGram(snapshot.ask),
      reference: gramPrice,
      high: perGram(snapshot.high),
      low: perGram(snapshot.low),
      change: perGram(snapshot.change),
      changePercent: snapshot.changePercent,
      currency: 'TRY',
      unit: 'gram',
      isEstimated: false,
      featured: true,
    },
    {
      code: 'ONS',
      name: 'Ons Altın',
      description: 'Global spot · TRY/toz',
      type: 'spot',
      price: round(snapshot.price),
      buy: snapshot.bid === null ? null : round(snapshot.bid),
      sell: snapshot.ask === null ? null : round(snapshot.ask),
      reference: round(snapshot.price),
      high: snapshot.high === null ? null : round(snapshot.high),
      low: snapshot.low === null ? null : round(snapshot.low),
      change: snapshot.change === null ? null : round(snapshot.change),
      changePercent: snapshot.changePercent,
      currency: 'TRY',
      unit: 'toz',
      isEstimated: false,
      featured: true,
    },
    {
      code: quarter.code,
      name: quarter.name,
      description: 'Teorik · 1,754 g · 916,6 milyem',
      type: 'theoretical',
      price: calculateTheoreticalValue(gramPrice, quarter),
      buy: null,
      sell: null,
      reference: calculateTheoreticalValue(gramPrice, quarter),
      high: null,
      low: null,
      change: null,
      changePercent: null,
      currency: 'TRY',
      unit: 'adet',
      isEstimated: true,
      featured: true,
    },
    {
      code: unityZiynet.code,
      name: unityZiynet.name,
      description: 'Teorik · 7,016 g · 916,6 milyem',
      type: 'theoretical',
      price: calculateTheoreticalValue(gramPrice, unityZiynet),
      buy: null,
      sell: null,
      reference: calculateTheoreticalValue(gramPrice, unityZiynet),
      high: null,
      low: null,
      change: null,
      changePercent: null,
      currency: 'TRY',
      unit: 'adet',
      isEstimated: true,
      featured: false,
    },
    {
      code: unityCoin.code,
      name: unityCoin.name,
      description: 'Teorik · 7,216 g · 916,6 milyem',
      type: 'theoretical',
      price: calculateTheoreticalValue(gramPrice, unityCoin),
      buy: null,
      sell: null,
      reference: calculateTheoreticalValue(gramPrice, unityCoin),
      high: null,
      low: null,
      change: null,
      changePercent: null,
      currency: 'TRY',
      unit: 'adet',
      isEstimated: true,
      featured: false,
    },
  ];
}

function buildPricePayload(snapshot, fetchedAt) {
  const rows = buildSpotRows(snapshot);
  return {
    source: 'Metals.dev',
    sourceType: 'spot',
    currency: 'TRY',
    unit: 'gram',
    sourceTimestamp: snapshot.timestamp,
    sourceDate: snapshot.timestamp,
    fetchedAt,
    updatedAt: snapshot.timestamp,
    freshness: 'fresh',
    staleAgeSeconds: null,
    isEstimated: rows.some((row) => row.isEstimated),
    disclaimer:
      'Global spot veridir; kuyumcu veya perakende alış/satış fiyatı ve yatırım tavsiyesi değildir.',
    rows,
  };
}

function buildMetalsDevUrl(apiKey) {
  const url = new URL(METALS_DEV_SPOT_PATH, METALS_DEV_ORIGIN);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.metals.dev' ||
    url.port ||
    url.pathname !== METALS_DEV_SPOT_PATH
  ) {
    throw new MetalsDevConfigurationError('Metals.dev endpoint doğrulaması başarısız.');
  }
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('metal', 'gold');
  url.searchParams.set('currency', 'TRY');
  return url;
}

function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) {
    return null;
  }
  if (/^\d+$/.test(String(value).trim())) {
    return Math.max(1_000, Number(value) * 1000);
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(1_000, retryAt - nowMs) : null;
}

async function readResponseText(response, maxBytes, controller) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    controller.abort();
    throw new MetalsDevDataError('Metals.dev yanıtı izin verilen boyutu aşıyor.');
  }

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        await reader.cancel().catch(() => {});
        throw new MetalsDevDataError('Metals.dev yanıtı izin verilen boyutu aşıyor.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    controller.abort();
    throw new MetalsDevDataError('Metals.dev yanıtı izin verilen boyutu aşıyor.');
  }
  return text;
}

class MetalsDevGoldProvider {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey ?? process.env.METALS_DEV_API_KEY ?? '').trim();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.cacheTtlMs = readPositiveNumber(
      options.cacheTtlMs ?? process.env.GOLD_CACHE_TTL_MS,
      DEFAULT_CACHE_TTL_MS,
    );
    this.timeoutMs = readPositiveNumber(
      options.timeoutMs ?? process.env.GOLD_REQUEST_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    );
    this.maxResponseBytes = readPositiveNumber(
      options.maxResponseBytes ?? process.env.GOLD_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.staleMaxAgeMs = readPositiveNumber(
      options.staleMaxAgeMs ?? process.env.GOLD_STALE_MAX_AGE_MS,
      DEFAULT_STALE_MAX_AGE_MS,
    );
    this.now = options.now || (() => Date.now());
    this.cache = null;
    this.lastKnownGood = null;
    this.inFlight = null;
    this.blockedUntil = 0;
    this.failureCount = 0;

    if (typeof this.fetchImpl !== 'function') {
      throw new MetalsDevConfigurationError('Node.js fetch desteği bulunamadı.');
    }
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  status() {
    return {
      provider: 'metals_dev',
      configured: this.isConfigured(),
      blockedUntil: this.blockedUntil
        ? new Date(this.blockedUntil).toISOString()
        : null,
    };
  }

  async fetchSnapshot() {
    if (!this.apiKey) {
      throw new MetalsDevConfigurationError(
        'METALS_DEV_API_KEY environment variable tanımlı değil.',
        { code: 'METALS_DEV_API_KEY_MISSING' },
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(buildMetalsDevUrl(this.apiKey), {
        headers: {
          accept: 'application/json',
          'user-agent': 'altinpiyasasi.com metals.dev spot client',
        },
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new MetalsDevConfigurationError('Metals.dev kimlik doğrulaması başarısız.', {
          code: `METALS_DEV_HTTP_${response.status}`,
        });
      }
      if (response.status === 429) {
        throw new MetalsDevHttpError(429, {
          code: 'METALS_DEV_RATE_LIMITED',
          retryAfterMs: parseRetryAfter(
            response.headers?.get?.('retry-after'),
            this.now(),
          ),
        });
      }
      if (!response.ok) {
        throw new MetalsDevHttpError(response.status);
      }

      const text = await readResponseText(
        response,
        this.maxResponseBytes,
        controller,
      );
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new MetalsDevDataError('Metals.dev geçerli JSON döndürmedi.', {
          cause: error,
        });
      }
      return validateSpotPayload(payload, {
        nowMs: this.now(),
        staleMaxAgeMs: this.staleMaxAgeMs,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new MetalsDevDataError('Metals.dev isteği zaman aşımına uğradı.', {
          code: 'METALS_DEV_TIMEOUT',
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  stalePayload(nowMs) {
    if (!this.lastKnownGood) {
      return null;
    }
    const sourceTime = Date.parse(this.lastKnownGood.sourceTimestamp);
    const ageMs = nowMs - sourceTime;
    if (!Number.isFinite(sourceTime) || ageMs < 0 || ageMs > this.staleMaxAgeMs) {
      return null;
    }
    return {
      ...this.lastKnownGood,
      freshness: 'stale',
      staleAgeSeconds: Math.floor(ageMs / 1000),
      warning: 'Spot veri geçici olarak güncellenemedi.',
    };
  }

  retryDelay(error) {
    if (error instanceof MetalsDevConfigurationError) {
      return CONFIGURATION_BACKOFF_MS;
    }
    const exponential = Math.min(
      30_000 * 2 ** Math.max(0, this.failureCount - 1),
      MAX_TRANSIENT_BACKOFF_MS,
    );
    return Math.max(exponential, error.retryAfterMs || 0);
  }

  async refresh() {
    const nowMs = this.now();
    const snapshot = await this.fetchSnapshot();
    const payload = buildPricePayload(
      snapshot,
      new Date(nowMs).toISOString(),
    );
    this.lastKnownGood = payload;
    this.cache = {
      expiresAt: nowMs + this.cacheTtlMs,
      payload,
    };
    this.failureCount = 0;
    this.blockedUntil = 0;
    return payload;
  }

  async getPrices() {
    const nowMs = this.now();
    if (this.cache && nowMs < this.cache.expiresAt) {
      const sourceAge = nowMs - Date.parse(this.cache.payload.sourceTimestamp);
      if (sourceAge <= this.staleMaxAgeMs) {
        return this.cache.payload;
      }
      this.cache = null;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    if (nowMs < this.blockedUntil) {
      const stale = this.stalePayload(nowMs);
      if (stale) {
        return stale;
      }
      throw new GoldPriceUnavailableError(undefined, {
        retryAfterSeconds: Math.ceil((this.blockedUntil - nowMs) / 1000),
      });
    }

    this.inFlight = this.refresh()
      .catch((error) => {
        this.failureCount += 1;
        const delay = this.retryDelay(error);
        this.blockedUntil = this.now() + delay;
        const stale = this.stalePayload(this.now());
        if (stale) {
          this.cache = { expiresAt: this.blockedUntil, payload: stale };
          return stale;
        }
        throw new GoldPriceUnavailableError(undefined, {
          code: error.code,
          cause: error,
          retryAfterSeconds: Math.ceil(delay / 1000),
        });
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_STALE_MAX_AGE_MS,
  DEFAULT_TIMEOUT_MS,
  GoldPriceUnavailableError,
  MAX_TRY_PER_TROY_OUNCE,
  METALS_DEV_ORIGIN,
  METALS_DEV_SPOT_PATH,
  MetalsDevConfigurationError,
  MetalsDevDataError,
  MetalsDevGoldProvider,
  MetalsDevHttpError,
  TROY_OUNCE_GRAMS,
  buildMetalsDevUrl,
  buildPricePayload,
  buildSpotRows,
  parseRetryAfter,
  readResponseText,
  validateSpotPayload,
};
