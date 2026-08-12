const {
  GoldPriceUnavailableError,
} = require('./metals-dev-gold-provider');

const TARGET_PRODUCTS = Object.freeze([
  Object.freeze({
    code: 'GRAM',
    name: 'Gram Altın',
    description: 'Global spot · TRY/gram',
    type: 'spot',
    unit: 'gram',
    provider: 'metalsDev',
    featured: true,
  }),
  Object.freeze({
    code: 'ONS',
    name: 'Ons Altın',
    description: 'Global spot · TRY/toz',
    type: 'spot',
    unit: 'toz',
    provider: 'metalsDev',
    featured: true,
  }),
  Object.freeze({
    code: 'CEYREK',
    name: 'Çeyrek Altın',
    description: 'Türkiye piyasası · Gerçek alış/satış',
    type: 'market',
    unit: 'adet',
    provider: 'collectApi',
    featured: true,
  }),
  Object.freeze({
    code: 'YARIM',
    name: 'Yarım Altın',
    description: 'Türkiye piyasası · Gerçek alış/satış',
    type: 'market',
    unit: 'adet',
    provider: 'collectApi',
    featured: false,
  }),
  Object.freeze({
    code: 'TAM',
    name: 'Tam Altın',
    description: 'Türkiye piyasası · Gerçek alış/satış',
    type: 'market',
    unit: 'adet',
    provider: 'collectApi',
    featured: false,
  }),
  Object.freeze({
    code: 'CUMHURIYET',
    name: 'Cumhuriyet Altını',
    description: 'Türkiye piyasası · Gerçek alış/satış',
    type: 'market',
    unit: 'adet',
    provider: 'collectApi',
    featured: false,
  }),
  Object.freeze({
    code: 'ATA',
    name: 'Ata Altın',
    description: 'Türkiye piyasası · Gerçek alış/satış',
    type: 'market',
    unit: 'adet',
    provider: 'collectApi',
    featured: false,
  }),
  Object.freeze({
    code: 'RESAT',
    name: 'Reşat Altını',
    description: 'Türkiye piyasası · Gerçek alış/satış',
    type: 'market',
    unit: 'adet',
    provider: 'collectApi',
    featured: false,
  }),
  Object.freeze({
    code: 'ALTIN_22',
    name: '22 Ayar Altın',
    description: 'Türkiye piyasası · Gerçek alış/satış',
    type: 'market',
    unit: 'gram',
    provider: 'collectApi',
    featured: false,
  }),
]);

function safeStatus(provider, fallbackName) {
  const status =
    typeof provider.status === 'function'
      ? provider.status()
      : {
          provider: fallbackName,
          configured:
            typeof provider.isConfigured === 'function'
              ? provider.isConfigured()
              : true,
        };
  return {
    provider: String(status.provider || fallbackName),
    configured: Boolean(status.configured),
    blockedUntil: status.blockedUntil || null,
  };
}

function positiveOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function createTargetRow(spec, sourceRow = null, allowChange = true) {
  const price = positiveOrNull(sourceRow?.price);
  const reference = positiveOrNull(sourceRow?.reference) || price;
  return {
    code: spec.code,
    name: spec.name,
    description: spec.description,
    type: spec.type,
    price,
    buy: positiveOrNull(sourceRow?.buy),
    sell: positiveOrNull(sourceRow?.sell),
    reference,
    high: positiveOrNull(sourceRow?.high),
    low: positiveOrNull(sourceRow?.low),
    change: allowChange ? finiteOrNull(sourceRow?.change) : null,
    changePercent: allowChange
      ? finiteOrNull(sourceRow?.changePercent)
      : null,
    currency: 'TRY',
    unit: spec.unit,
    isEstimated: false,
    featured: spec.featured,
  };
}

function rowsByCode(result) {
  if (result.status !== 'fulfilled' || !Array.isArray(result.value?.rows)) {
    return new Map();
  }
  return new Map(result.value.rows.map((row) => [row.code, row]));
}

function providerMetadata(result, provider, fallbackName) {
  const status = safeStatus(provider, fallbackName);
  const payload = result.status === 'fulfilled' ? result.value : null;
  return {
    provider: status.provider,
    configured: status.configured,
    available: Boolean(payload),
    blockedUntil: status.blockedUntil,
    source: payload?.source || null,
    sourceType: payload?.sourceType || null,
    sourceTimestamp: payload?.sourceTimestamp || null,
    fetchedAt: payload?.fetchedAt || null,
    freshness: payload?.freshness || 'unavailable',
    staleAgeSeconds: payload?.staleAgeSeconds ?? null,
  };
}

function latestIso(values) {
  const valid = values
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return valid.length ? new Date(Math.max(...valid)).toISOString() : null;
}

function retryAfterSeconds(results) {
  const delays = results
    .filter((result) => result.status === 'rejected')
    .map((result) => Number(result.reason?.retryAfterSeconds))
    .filter((value) => Number.isFinite(value) && value > 0);
  return delays.length ? Math.min(...delays) : 60;
}

class CombinedGoldProvider {
  constructor(options = {}) {
    if (!options.metalsProvider || !options.collectProvider) {
      throw new TypeError('Birleşik provider için iki fiyat sağlayıcısı gereklidir.');
    }
    this.metalsProvider = options.metalsProvider;
    this.collectProvider = options.collectProvider;
  }

  isConfigured() {
    return (
      safeStatus(this.metalsProvider, 'metals_dev').configured ||
      safeStatus(this.collectProvider, 'collectapi').configured
    );
  }

  status() {
    const metalsDev = safeStatus(this.metalsProvider, 'metals_dev');
    const collectApi = safeStatus(this.collectProvider, 'collectapi');
    return {
      provider: 'combined',
      configured: metalsDev.configured || collectApi.configured,
      blockedUntil: null,
      providers: { metalsDev, collectApi },
    };
  }

  async getPrices() {
    const results = await Promise.allSettled([
      this.metalsProvider.getPrices(),
      this.collectProvider.getPrices(),
    ]);
    if (results.every((result) => result.status === 'rejected')) {
      throw new GoldPriceUnavailableError(
        'Altın fiyat sağlayıcıları şu anda kullanılamıyor.',
        { retryAfterSeconds: retryAfterSeconds(results) },
      );
    }

    const [metalsResult, collectResult] = results;
    const providerResults = { metalsDev: metalsResult, collectApi: collectResult };
    const sourceRows = {
      metalsDev: rowsByCode(metalsResult),
      collectApi: rowsByCode(collectResult),
    };
    const rows = TARGET_PRODUCTS.map((spec) => {
      const result = providerResults[spec.provider];
      return createTargetRow(
        spec,
        sourceRows[spec.provider].get(spec.code),
        result.status === 'fulfilled' && result.value?.freshness !== 'stale',
      );
    });

    const providers = {
      metalsDev: providerMetadata(
        metalsResult,
        this.metalsProvider,
        'metals_dev',
      ),
      collectApi: providerMetadata(
        collectResult,
        this.collectProvider,
        'collectapi',
      ),
    };
    const available = Object.values(providers).filter(
      (provider) => provider.available,
    );
    const isPartial = available.length !== 2;
    const isStale = available.some(
      (provider) => provider.freshness === 'stale',
    );
    const source = available.map((provider) => provider.source).filter(Boolean);
    const sourceTimestamp = latestIso(
      available.map((provider) => provider.sourceTimestamp),
    );
    const fetchedAt = latestIso(
      available.map((provider) => provider.fetchedAt),
    );

    return {
      source: source.join(' + ') || 'Birleşik fiyat akışı',
      sourceType: available.length === 2 ? 'mixed' : available[0]?.sourceType,
      currency: 'TRY',
      unit: 'mixed',
      sourceTimestamp,
      sourceDate: sourceTimestamp,
      fetchedAt,
      updatedAt: sourceTimestamp || fetchedAt,
      freshness: isPartial ? 'partial' : isStale ? 'stale' : 'fresh',
      staleAgeSeconds: isStale
        ? Math.max(
            ...available.map((provider) => provider.staleAgeSeconds || 0),
          )
        : null,
      isEstimated: false,
      providers,
      rows,
    };
  }
}

module.exports = {
  CombinedGoldProvider,
  TARGET_PRODUCTS,
  createTargetRow,
  providerMetadata,
};
