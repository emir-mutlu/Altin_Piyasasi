const {
  GoldPriceUnavailableError,
} = require('./metals-dev-gold-provider');

const COLLECTAPI_ORIGIN = 'https://api.collectapi.com';
const COLLECTAPI_GOLD_PATH = '/economy/goldPrice';
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_STALE_MAX_AGE_MS = 5 * 60 * 1000;
const CONFIGURATION_BACKOFF_MS = 15 * 60 * 1000;
const MAX_TRANSIENT_BACKOFF_MS = 5 * 60 * 1000;
const MAX_TRY_PRICE = 100_000_000;

const PRODUCT_ALIASES = new Map([
  ['çeyrek altın', 'CEYREK'],
  ['yarım altın', 'YARIM'],
  ['tam altın', 'TAM'],
  ['cumhuriyet altını', 'CUMHURIYET'],
  ['ata altın', 'ATA'],
  ['reşat lira altın', 'RESAT'],
  ['22 ayar bilezik', 'ALTIN_22'],
]);

const PRODUCT_DEFINITIONS = Object.freeze({
  CEYREK: Object.freeze({
    name: 'Çeyrek Altın',
    unit: 'adet',
    featured: true,
  }),
  YARIM: Object.freeze({
    name: 'Yarım Altın',
    unit: 'adet',
    featured: false,
  }),
  TAM: Object.freeze({
    name: 'Tam Altın',
    unit: 'adet',
    featured: false,
  }),
  CUMHURIYET: Object.freeze({
    name: 'Cumhuriyet Altını',
    unit: 'adet',
    featured: false,
  }),
  ATA: Object.freeze({
    name: 'Ata Altın',
    unit: 'adet',
    featured: false,
  }),
  RESAT: Object.freeze({
    name: 'Reşat Altını',
    unit: 'adet',
    featured: false,
  }),
  ALTIN_22: Object.freeze({
    name: '22 Ayar Bilezik',
    unit: 'gram',
    featured: false,
  }),
});

class CollectApiDataError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'CollectApiDataError';
    this.code = options.code || 'INVALID_PROVIDER_DATA';
    this.retryable = options.retryable !== false;
  }
}

class CollectApiConfigurationError extends Error {
  constructor(
    message = 'CollectAPI yapılandırması eksik veya geçersiz.',
    options = {},
  ) {
    super(message, options);
    this.name = 'CollectApiConfigurationError';
    this.code = options.code || 'PROVIDER_CONFIGURATION_ERROR';
    this.statusCode = 503;
    this.retryable = false;
  }
}

class CollectApiHttpError extends Error {
  constructor(status, options = {}) {
    super(`CollectAPI isteği HTTP ${status} durumuyla başarısız oldu.`);
    this.name = 'CollectApiHttpError';
    this.code = options.code || 'PROVIDER_HTTP_ERROR';
    this.status = status;
    this.retryable = options.retryable !== false;
    this.retryAfterMs = options.retryAfterMs || null;
  }
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProductName(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('tr-TR');
}

function parseCollectApiPrice(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 && value <= MAX_TRY_PRICE
      ? value
      : null;
  }
  if (typeof value !== 'string') {
    return null;
  }

  let normalized = value
    .trim()
    .replace(/\u00a0/g, '')
    .replace(/\s+/g, '')
    .replace(/^₺|₺$/g, '')
    .replace(/^TL|TL$/gi, '');

  if (!normalized || normalized === '-') {
    return null;
  }

  if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+,\d+$/.test(normalized)) {
    normalized = normalized.replace(',', '.');
  } else if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    // CollectAPI's documented examples use a dot as the decimal separator.
  } else {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_TRY_PRICE
    ? parsed
    : null;
}

function firstValidPrice(values) {
  for (const raw of values) {
    if (raw === undefined || raw === null || raw === '' || raw === '-') {
      continue;
    }
    const value = parseCollectApiPrice(raw);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function createMarketRow(code, item) {
  const definition = PRODUCT_DEFINITIONS[code];
  const buy = firstValidPrice([item.buying, item.buy, item.buyingstr]);
  const sell = firstValidPrice([item.selling, item.sell, item.sellingstr]);

  return {
    code,
    name: definition.name,
    description: 'Türkiye piyasası · Gerçek alış/satış',
    type: 'market',
    price: sell,
    buy,
    sell,
    reference: sell,
    high: null,
    low: null,
    change: null,
    changePercent: null,
    currency: 'TRY',
    unit: definition.unit,
    isEstimated: false,
    featured: definition.featured,
  };
}

function parseSourceTimestamp(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return null;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs)
    ? new Date(timestampMs).toISOString()
    : null;
}

function latestSourceTimestamp(values) {
  const timestamps = values
    .map(parseSourceTimestamp)
    .filter(Boolean)
    .map((value) => Date.parse(value));
  return timestamps.length
    ? new Date(Math.max(...timestamps)).toISOString()
    : null;
}

function parseCollectApiPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CollectApiDataError(
      'CollectAPI yanıtı bir JSON nesnesi olmalıdır.',
    );
  }
  if (payload.success !== true) {
    throw new CollectApiDataError('CollectAPI yanıt durumu başarılı değil.');
  }
  if (!Array.isArray(payload.result)) {
    throw new CollectApiDataError('CollectAPI result alanı bir dizi olmalıdır.');
  }

  const rowsByCode = new Map();
  const sourceTimestamps = [];
  for (const item of payload.result) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    if (typeof item.name !== 'string' || !item.name.trim()) {
      continue;
    }
    const code = PRODUCT_ALIASES.get(normalizeProductName(item.name));
    if (!code) {
      continue;
    }
    if (rowsByCode.has(code)) {
      throw new CollectApiDataError(
        `CollectAPI ${code} ürünü için birden fazla kesin eşleşme döndürdü.`,
      );
    }
    rowsByCode.set(code, createMarketRow(code, item));
    sourceTimestamps.push(item.datetime);
  }

  return {
    rows: [...rowsByCode.values()],
    sourceTimestamp: latestSourceTimestamp(sourceTimestamps),
  };
}

function validateCollectApiPayload(payload) {
  return parseCollectApiPayload(payload).rows;
}

function buildCollectApiUrl() {
  const url = new URL(COLLECTAPI_GOLD_PATH, COLLECTAPI_ORIGIN);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.collectapi.com' ||
    url.port ||
    url.pathname !== COLLECTAPI_GOLD_PATH ||
    url.search
  ) {
    throw new CollectApiConfigurationError(
      'CollectAPI endpoint doğrulaması başarısız.',
    );
  }
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
    throw new CollectApiDataError(
      'CollectAPI yanıtı izin verilen boyutu aşıyor.',
    );
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
        throw new CollectApiDataError(
          'CollectAPI yanıtı izin verilen boyutu aşıyor.',
        );
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    controller.abort();
    throw new CollectApiDataError(
      'CollectAPI yanıtı izin verilen boyutu aşıyor.',
    );
  }
  return text;
}

function buildPricePayload(rows, fetchedAt, sourceTimestamp = null) {
  return {
    source: 'CollectAPI',
    sourceType: 'market',
    currency: 'TRY',
    unit: 'mixed',
    sourceTimestamp,
    sourceDate: sourceTimestamp,
    fetchedAt,
    updatedAt: sourceTimestamp || fetchedAt,
    freshness: 'fresh',
    staleAgeSeconds: null,
    isEstimated: false,
    rows,
  };
}

class CollectApiGoldProvider {
  constructor(options = {}) {
    this.token = String(options.token || '').trim();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.cacheTtlMs = readPositiveNumber(
      options.cacheTtlMs,
      DEFAULT_CACHE_TTL_MS,
    );
    this.timeoutMs = readPositiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = readPositiveNumber(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.staleMaxAgeMs = readPositiveNumber(
      options.staleMaxAgeMs,
      DEFAULT_STALE_MAX_AGE_MS,
    );
    this.now = options.now || (() => Date.now());
    this.cache = null;
    this.lastKnownGood = null;
    this.inFlight = null;
    this.blockedUntil = 0;
    this.failureCount = 0;

    if (typeof this.fetchImpl !== 'function') {
      throw new CollectApiConfigurationError('Node.js fetch desteği bulunamadı.');
    }
  }

  isConfigured() {
    return Boolean(this.token);
  }

  status() {
    return {
      provider: 'collectapi',
      configured: this.isConfigured(),
      blockedUntil: this.blockedUntil
        ? new Date(this.blockedUntil).toISOString()
        : null,
    };
  }

  async fetchRows() {
    if (!this.token) {
      throw new CollectApiConfigurationError(
        'COLLECTAPI_TOKEN environment variable tanımlı değil.',
        { code: 'COLLECTAPI_TOKEN_MISSING' },
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(buildCollectApiUrl(), {
        headers: {
          accept: 'application/json',
          authorization: `apikey ${this.token}`,
          'user-agent': 'altinpiyasasi.com CollectAPI gold client',
        },
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new CollectApiConfigurationError(
          'CollectAPI kimlik doğrulaması başarısız.',
          { code: `COLLECTAPI_HTTP_${response.status}` },
        );
      }
      if (response.status === 429) {
        throw new CollectApiHttpError(429, {
          code: 'COLLECTAPI_RATE_LIMITED',
          retryAfterMs: parseRetryAfter(
            response.headers?.get?.('retry-after'),
            this.now(),
          ),
        });
      }
      if (!response.ok) {
        throw new CollectApiHttpError(response.status);
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
        throw new CollectApiDataError('CollectAPI geçerli JSON döndürmedi.', {
          cause: error,
        });
      }
      return parseCollectApiPayload(payload);
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new CollectApiDataError(
          'CollectAPI isteği zaman aşımına uğradı.',
          { code: 'COLLECTAPI_TIMEOUT', cause: error },
        );
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
    const fetchedAtMs = Date.parse(this.lastKnownGood.fetchedAt);
    const ageMs = nowMs - fetchedAtMs;
    if (!Number.isFinite(fetchedAtMs) || ageMs < 0 || ageMs > this.staleMaxAgeMs) {
      return null;
    }
    return {
      ...this.lastKnownGood,
      freshness: 'stale',
      staleAgeSeconds: Math.floor(ageMs / 1000),
      warning: 'Fiziksel altın verisi geçici olarak güncellenemedi.',
    };
  }

  retryDelay(error) {
    if (error instanceof CollectApiConfigurationError) {
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
    const snapshot = await this.fetchRows();
    const payload = buildPricePayload(
      snapshot.rows,
      new Date(nowMs).toISOString(),
      snapshot.sourceTimestamp,
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
      const ageMs = nowMs - Date.parse(this.cache.payload.fetchedAt);
      if (ageMs <= this.staleMaxAgeMs) {
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
  COLLECTAPI_GOLD_PATH,
  COLLECTAPI_ORIGIN,
  CollectApiConfigurationError,
  CollectApiDataError,
  CollectApiGoldProvider,
  CollectApiHttpError,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_STALE_MAX_AGE_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_TRY_PRICE,
  PRODUCT_ALIASES,
  PRODUCT_DEFINITIONS,
  buildCollectApiUrl,
  buildPricePayload,
  normalizeProductName,
  parseCollectApiPayload,
  parseCollectApiPrice,
  parseSourceTimestamp,
  parseRetryAfter,
  readResponseText,
  validateCollectApiPayload,
};
