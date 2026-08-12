const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const {
  BistGoldProvider,
} = require('./services/bist-gold-provider');
const {
  GoldPriceUnavailableError,
  MetalsDevGoldProvider,
} = require('./services/metals-dev-gold-provider');
const {
  CollectApiGoldProvider,
} = require('./services/collectapi-gold-provider');
const {
  CombinedGoldProvider,
} = require('./services/combined-gold-provider');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const NEWS_TTL_MS = 90_000;
const EXTERNAL_TIMEOUT_MS = 4_500;
const GOOGLE_NEWS_RSS_URL = 'https://news.google.com/rss/search';
const SHUTDOWN_TIMEOUT_MS = 10_000;
const NEWS_RESPONSE_MAX_BYTES = 512 * 1024;
const PRICE_RATE_LIMIT = Object.freeze({ limit: 120, windowMs: 60_000 });
const NEWS_RATE_LIMIT = Object.freeze({ limit: 60, windowMs: 60_000 });

const newsCache = { timestamp: 0, payload: null };

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

function applySecurityHeaders(response, isProduction) {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()',
  );
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Origin-Agent-Cluster', '?1');
  response.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  response.setHeader('X-Frame-Options', 'DENY');
  if (isProduction) {
    response.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(
    response.req?.method === 'HEAD' ? undefined : JSON.stringify(payload),
  );
}

function sendText(response, statusCode, message, headers = {}) {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(response.req?.method === 'HEAD' ? undefined : message);
}

function methodNotAllowed(response, methods) {
  sendJson(
    response,
    405,
    { error: 'Bu endpoint için HTTP metodu desteklenmiyor.' },
    { allow: methods.join(', ') },
  );
}

class InMemoryRateLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.clients = new Map();
    this.lastCleanupAt = 0;
  }

  consume(key) {
    const nowMs = this.now();
    if (nowMs - this.lastCleanupAt >= this.windowMs) {
      for (const [clientKey, entry] of this.clients) {
        if (nowMs >= entry.resetAt) {
          this.clients.delete(clientKey);
        }
      }
      this.lastCleanupAt = nowMs;
    }
    let entry = this.clients.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      entry = { count: 0, resetAt: nowMs + this.windowMs };
    }
    entry.count += 1;
    this.clients.set(key, entry);
    return {
      allowed: entry.count <= this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)),
    };
  }
}

function clientAddress(request) {
  return request.socket?.remoteAddress || 'unknown';
}

function applyRateLimit(request, response, limiter) {
  const result = limiter.consume(clientAddress(request));
  response.setHeader('X-RateLimit-Remaining', String(result.remaining));
  if (result.allowed) {
    return true;
  }
  sendJson(
    response,
    429,
    { error: 'Çok fazla istek gönderildi. Lütfen daha sonra tekrar deneyin.' },
    { 'retry-after': String(result.retryAfterSeconds) },
  );
  return false;
}

class UnavailablePriceProvider {
  constructor(provider, message) {
    this.provider = provider;
    this.message = message;
  }

  isConfigured() {
    return false;
  }

  status() {
    return { provider: this.provider, configured: false, blockedUntil: null };
  }

  async getPrices() {
    throw new GoldPriceUnavailableError(this.message, {
      code: 'PROVIDER_CONFIGURATION_ERROR',
      retryAfterSeconds: 900,
    });
  }
}

function createPriceProvider(env = process.env, options = {}) {
  const providerName = String(env.GOLD_PROVIDER || 'metals_dev').toLowerCase();
  if (providerName === 'metals_dev' || providerName === 'metals-dev') {
    return new CombinedGoldProvider({
      metalsProvider: new MetalsDevGoldProvider({
        apiKey: env.METALS_DEV_API_KEY,
        cacheTtlMs: env.GOLD_CACHE_TTL_MS,
        timeoutMs: env.GOLD_REQUEST_TIMEOUT_MS,
        maxResponseBytes: env.GOLD_MAX_RESPONSE_BYTES,
        staleMaxAgeMs: env.GOLD_STALE_MAX_AGE_MS,
        ...options.metalsDev,
      }),
      collectProvider: new CollectApiGoldProvider({
        token: env.COLLECTAPI_TOKEN,
        cacheTtlMs: env.COLLECTAPI_CACHE_TTL_MS,
        timeoutMs: env.COLLECTAPI_REQUEST_TIMEOUT_MS,
        maxResponseBytes: env.COLLECTAPI_MAX_RESPONSE_BYTES,
        staleMaxAgeMs: env.COLLECTAPI_STALE_MAX_AGE_MS,
        ...options.collectApi,
      }),
    });
  }
  if (providerName === 'bist' && env.NODE_ENV !== 'production') {
    return new BistGoldProvider(options.bist);
  }
  if (providerName === 'bist') {
    return new UnavailablePriceProvider(
      'bist',
      'BIST provider production ortamında kullanılamaz.',
    );
  }
  return new UnavailablePriceProvider(
    providerName,
    'GOLD_PROVIDER değeri desteklenmiyor.',
  );
}

function providerStatus(provider) {
  if (typeof provider.status === 'function') {
    const status = provider.status();
    const safeStatus = {
      provider: status.provider,
      configured: Boolean(status.configured),
      blockedUntil: status.blockedUntil || null,
    };
    if (status.providers && typeof status.providers === 'object') {
      safeStatus.providers = Object.fromEntries(
        Object.entries(status.providers).map(([name, child]) => [
          name,
          {
            provider: child.provider,
            configured: Boolean(child.configured),
            blockedUntil: child.blockedUntil || null,
          },
        ]),
      );
    }
    return safeStatus;
  }
  return {
    provider: provider instanceof BistGoldProvider ? 'bist' : 'unknown',
    configured:
      typeof provider.isConfigured === 'function'
        ? Boolean(provider.isConfigured())
        : true,
    blockedUntil: null,
  };
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(value) {
  return decodeXmlEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readXmlTag(block, tag) {
  const match = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  );
  return match ? decodeXmlEntities(match[1]).trim() : '';
}

function parseRssItems(xml) {
  return [...String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)]
    .map((match) => {
      const block = match[0];
      const title = stripTags(readXmlTag(block, 'title'));
      const link = safeExternalHttpsUrl(stripTags(readXmlTag(block, 'link')));
      const description = stripTags(readXmlTag(block, 'description'));
      const source = stripTags(readXmlTag(block, 'source')) || 'Google News';
      const pubDate = stripTags(readXmlTag(block, 'pubDate'));
      const publishedAt =
        pubDate && !Number.isNaN(Date.parse(pubDate))
          ? new Date(pubDate).toISOString()
          : new Date().toISOString();

      if (!title || !link) {
        return null;
      }

      return {
        title,
        source,
        publishedAt,
        url: link,
        image: '',
        summary:
          description && description !== title ? description.slice(0, 180) : '',
      };
    })
    .filter(Boolean);
}

async function readLimitedResponseText(
  response,
  maxBytes = NEWS_RESPONSE_MAX_BYTES,
) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('External response exceeded the safe size limit.');
  }

  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('External response exceeded the safe size limit.');
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

async function fetchExternalText(
  url,
  options = {},
  timeoutMs = EXTERNAL_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return {
      response,
      text: await readLimitedResponseText(response),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackNews() {
  return {
    source: 'fallback',
    updatedAt: null,
    items: [
      {
        title: 'Küresel ons altın, merkez bankası beklentileriyle yön arıyor',
        source: 'Statik piyasa bilgisi',
        publishedAt: null,
        url: '#',
        image: '',
        summary:
          'Altın piyasasında gün içi oynaklık, dolar endeksi ve tahvil faizlerindeki hareketle takip ediliyor.',
      },
      {
        title: 'Gram altında kur etkisi ve ons fiyatı birlikte izleniyor',
        source: 'Statik piyasa bilgisi',
        publishedAt: null,
        url: '#',
        image: '',
        summary:
          'Yatırımcıların odağında piyasa referansları, USD/TRY ve global risk iştahı bulunuyor.',
      },
      {
        title: 'Mücevher ve yatırım altını talebi yakından takip ediliyor',
        source: 'Statik piyasa bilgisi',
        publishedAt: null,
        url: '#',
        image: '',
        summary:
          'Fiziki talep ve uluslararası piyasa koşulları altın gündeminde izleniyor.',
      },
    ],
  };
}

function sanitizeNewsItem(item) {
  const title = String(item.title || '').trim();
  const url = safeExternalHttpsUrl(item.url);

  if (!title || !url) {
    return null;
  }

  return {
    title,
    source: String(item.domain || item.source?.name || 'Haber').replace(
      /^www\./,
      '',
    ),
    publishedAt: item.seendate || item.publishedAt || null,
    url,
    image: safeExternalHttpsUrl(item.socialimage || item.urlToImage) || '',
    summary: String(item.description || item.summary || '').trim(),
  };
}

function safeExternalHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

async function fetchNewsApiNews() {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) {
    throw new Error('NEWS_API_KEY is not configured');
  }

  const url = new URL('https://newsapi.org/v2/everything');
  url.searchParams.set('q', 'altın OR gram altın OR ons altın');
  url.searchParams.set('language', 'tr');
  url.searchParams.set('sortBy', 'publishedAt');
  url.searchParams.set('pageSize', '12');
  url.searchParams.set('apiKey', apiKey);

  const { response, text } = await fetchExternalText(url, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`NewsAPI request failed: ${response.status}`);
  }

  const payload = JSON.parse(text);
  const items = (payload.articles || []).map(sanitizeNewsItem).filter(Boolean);
  if (!items.length) {
    throw new Error('NewsAPI returned no usable articles');
  }

  return {
    source: 'newsapi',
    updatedAt: new Date().toISOString(),
    items,
  };
}

async function fetchGoogleNewsRssNews() {
  const url = new URL(GOOGLE_NEWS_RSS_URL);
  url.searchParams.set(
    'q',
    '"altın fiyatları" OR "gram altın" OR "ons altın" when:7d',
  );
  url.searchParams.set('hl', 'tr');
  url.searchParams.set('gl', 'TR');
  url.searchParams.set('ceid', 'TR:tr');

  const { response, text } = await fetchExternalText(
    url,
    {
      headers: {
        accept: 'application/rss+xml, application/xml, text/xml',
        'user-agent': 'Mozilla/5.0 altinpiyasasi.com news preview',
      },
    },
    7_000,
  );

  if (!response.ok) {
    throw new Error(`Google News RSS request failed: ${response.status}`);
  }

  const items = parseRssItems(text);
  if (!items.length) {
    throw new Error('Google News RSS returned no usable items');
  }

  return {
    source: 'google-news',
    updatedAt: new Date().toISOString(),
    items: items.slice(0, 12),
  };
}

async function fetchGdeltNews() {
  const query =
    '(gold OR "gold price" OR "gram gold" OR "gold market") sourcelang:turkish';
  const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  url.searchParams.set('query', query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('format', 'json');
  url.searchParams.set('maxrecords', '12');
  url.searchParams.set('timespan', '2weeks');
  url.searchParams.set('sort', 'datedesc');

  const { response, text } = await fetchExternalText(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'altinpiyasasi.com news preview',
    },
  });

  if (!response.ok) {
    throw new Error(`GDELT request failed: ${response.status}`);
  }

  const payload = JSON.parse(text);
  const items = (payload.articles || []).map(sanitizeNewsItem).filter(Boolean);
  if (!items.length) {
    throw new Error('GDELT returned no usable articles');
  }

  return {
    source: 'gdelt',
    updatedAt: new Date().toISOString(),
    items,
  };
}

async function getNews() {
  const now = Date.now();
  if (newsCache.payload && now - newsCache.timestamp < NEWS_TTL_MS) {
    return newsCache.payload;
  }

  try {
    newsCache.payload = await fetchNewsApiNews();
  } catch (newsApiError) {
    try {
      newsCache.payload = await fetchGoogleNewsRssNews();
    } catch (googleNewsError) {
      try {
        newsCache.payload = await fetchGdeltNews();
      } catch (gdeltError) {
        newsCache.payload = fallbackNews();
        newsCache.payload.error =
          'Canlı haber kaynaklarına geçici olarak ulaşılamadı.';
      }
    }
  }

  newsCache.timestamp = now;
  return newsCache.payload;
}

async function serveStatic(requestUrl, response) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(requestUrl.pathname).replace(/\\/g, '/');
  } catch {
    sendText(response, 400, 'Bad request');
    return;
  }

  if (/[\0-\x1f\x7f]/.test(urlPath)) {
    sendText(response, 400, 'Bad request');
    return;
  }

  const requestedPath = urlPath === '/' ? '/index.html' : urlPath;
  const pathSegments = requestedPath.split('/').filter(Boolean);
  if (pathSegments.some((segment) => segment.startsWith('.'))) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  const relativePath = path.relative(PUBLIC_DIR, filePath);

  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  try {
    const [publicRealPath, fileRealPath] = await Promise.all([
      fs.realpath(PUBLIC_DIR),
      fs.realpath(filePath),
    ]);
    const realRelativePath = path.relative(publicRealPath, fileRealPath);
    if (
      realRelativePath === '..' ||
      realRelativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelativePath)
    ) {
      sendText(response, 403, 'Forbidden');
      return;
    }

    const file = await fs.readFile(fileRealPath);
    const contentType =
      contentTypes.get(path.extname(fileRealPath).toLowerCase()) ||
      'application/octet-stream';
    const isHtml = contentType.includes('html');
    const isRobots = path.basename(fileRealPath).toLowerCase() === 'robots.txt';
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': String(file.byteLength),
      'cache-control': isHtml
        ? 'no-store'
        : isRobots
          ? 'public, max-age=300'
          : 'public, max-age=3600',
      ...(isHtml ? { 'content-language': 'tr' } : {}),
    });
    response.end(response.req?.method === 'HEAD' ? undefined : file);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) {
      sendText(response, 404, 'Not found');
      return;
    }

    if (['EACCES', 'EPERM'].includes(error.code)) {
      sendText(response, 403, 'Forbidden');
      return;
    }

    sendText(response, 500, 'Server error');
  }
}

function createAppServer(options = {}) {
  const env = options.env || process.env;
  const isProduction = env.NODE_ENV === 'production';
  const priceProvider =
    options.priceProvider || createPriceProvider(env, options.providerOptions);
  const getNewsImpl = options.getNews || getNews;
  const priceLimiter =
    options.priceLimiter || new InMemoryRateLimiter(PRICE_RATE_LIMIT);
  const newsLimiter =
    options.newsLimiter || new InMemoryRateLimiter(NEWS_RATE_LIMIT);

  return http.createServer(async (request, response) => {
    applySecurityHeaders(response, isProduction);

    try {
      const requestUrl = new URL(request.url, 'http://localhost');
      if (
        requestUrl.pathname === '/health' ||
        requestUrl.pathname === '/api' ||
        requestUrl.pathname.startsWith('/api/')
      ) {
        response.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      }

      if (requestUrl.pathname === '/api/prices') {
        if (request.method !== 'GET') {
          methodNotAllowed(response, ['GET']);
          return;
        }
        if (!applyRateLimit(request, response, priceLimiter)) {
          return;
        }
        try {
          sendJson(response, 200, await priceProvider.getPrices());
        } catch (error) {
          if (
            error instanceof GoldPriceUnavailableError ||
            error.statusCode === 503
          ) {
            const status = providerStatus(priceProvider);
            const retryAfterSeconds = error.retryAfterSeconds || 60;
            sendJson(
              response,
              503,
              {
                source:
                  status.provider === 'metals_dev'
                    ? 'Metals.dev'
                    : status.provider === 'combined'
                      ? 'Metals.dev + CollectAPI'
                    : status.provider,
                sourceType:
                  status.provider === 'metals_dev'
                    ? 'spot'
                    : status.provider === 'combined'
                      ? 'mixed'
                      : 'reference',
                freshness: 'unavailable',
                configured: status.configured,
                ...(status.providers ? { providers: status.providers } : {}),
                isEstimated: false,
                error: status.configured
                  ? 'Altın fiyatları şu anda kullanılamıyor.'
                  : 'Altın fiyat sağlayıcısı yapılandırılmamış.',
              },
              { 'retry-after': String(retryAfterSeconds) },
            );
            return;
          }
          throw error;
        }
        return;
      }

      if (requestUrl.pathname === '/api/news') {
        if (request.method !== 'GET') {
          methodNotAllowed(response, ['GET']);
          return;
        }
        if (!applyRateLimit(request, response, newsLimiter)) {
          return;
        }
        sendJson(response, 200, await getNewsImpl());
        return;
      }

      if (requestUrl.pathname === '/health') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          methodNotAllowed(response, ['GET', 'HEAD']);
          return;
        }
        const status = providerStatus(priceProvider);
        sendJson(response, 200, {
          ok: true,
          ready: status.configured,
          priceProvider: status,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        methodNotAllowed(response, ['GET', 'HEAD']);
        return;
      }
      await serveStatic(requestUrl, response);
    } catch (error) {
      console.error('Request failed safely', {
        name: error?.name || 'Error',
        code: error?.code || 'UNEXPECTED_ERROR',
      });
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'Sunucu isteği tamamlanamadı.' });
      } else {
        response.destroy();
      }
    }
  });
}

function installGracefulShutdown(server, options = {}) {
  const exit = options.exit || ((code) => process.exit(code));
  const timeoutMs = options.timeoutMs || SHUTDOWN_TIMEOUT_MS;
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`${signal} alındı; sunucu kontrollü olarak kapatılıyor.`);
    const forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      exit(1);
    }, timeoutMs);
    forceTimer.unref?.();

    server.close(() => {
      clearTimeout(forceTimer);
      exit(0);
    });
    server.closeIdleConnections?.();
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return shutdown;
}

function startServer(options = {}) {
  const env = options.env || process.env;
  const port = Number(env.PORT || PORT);
  const server = createAppServer({ ...options, env });
  server.listen(port, HOST, () => {
    console.log(`Altinpiyasasi.com running at http://${HOST}:${port}`);
  });
  installGracefulShutdown(server, options.shutdown);
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  HOST,
  InMemoryRateLimiter,
  applySecurityHeaders,
  clientAddress,
  createAppServer,
  createPriceProvider,
  fallbackNews,
  installGracefulShutdown,
  methodNotAllowed,
  providerStatus,
  readLimitedResponseText,
  safeExternalHttpsUrl,
  startServer,
};
