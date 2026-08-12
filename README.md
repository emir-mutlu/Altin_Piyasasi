# altinpiyasasi.com

Vanilla HTML, CSS ve JavaScript frontend ile yerleşik `node:http` backend kullanan global spot altın piyasası uygulaması.

## Gereksinimler

- Node.js 18 veya üzeri
- Production fiyat akışı için Metals.dev API key ve CollectAPI token

## Yerel çalıştırma

```powershell
npm ci
$env:METALS_DEV_API_KEY="your_metals_dev_api_key"
$env:COLLECTAPI_TOKEN="your_collectapi_token"
$env:GOLD_PROVIDER="metals_dev"
npm start
```

Ardından `http://localhost:3000` adresini açın. PowerShell execution policy `npm` komutunu engelliyorsa `npm.cmd ci`, `npm.cmd test` ve `npm.cmd start` kullanın.

İki fiyat anahtarı da yokken sunucu ve `/health` çalışır; `/api/prices` güvenli biçimde HTTP 503 döndürür ve demo fiyat üretmez. Sağlayıcılardan yalnızca biri yapılandırılmışsa diğer sağlayıcıya ait satırlar boş bırakılarak mevcut gerçek veri sunulur.

## Fiyat sağlayıcıları

Production varsayılanı birleşik fiyat akışıdır. `GOLD_PROVIDER=metals_dev` geriye uyumlu adıyla backend, Gram ve Ons için sabit `https://api.metals.dev/v1/metal/spot`; fiziksel Türkiye ürünleri için sabit `https://api.collectapi.com/economy/goldPrice` endpoint'ine bağlanır. CollectAPI kimlik doğrulaması yalnızca backend `Authorization` header'ında yapılır.

`GOLD_PROVIDER=bist` yalnızca development ortamında açıkça seçilebilen eski resmî referans provider'ıdır. Metals.dev hatasında BIST'e otomatik fallback yapılmaz.

## Fiyat sınıfları

- Gram Altın: Metals.dev global spot TRY/gram.
- Ons Altın: Metals.dev global spot TRY/troy ounce.
- Çeyrek, Yarım, Tam, Cumhuriyet, Ata, Reşat ve 22 Ayar Altın: CollectAPI gerçek piyasa alış/satış verisi.

Fiziksel ürünlerde teorik değer veya yapay spread üretilmez. CollectAPI yalnızca alış/satış döndürürse `price` ve `reference` için `sell` kullanılır; alış/satış ortalaması alınmaz. Doğrulanmış günlük değişim alanı bulunmadığı için bu satırlarda `change` ve `changePercent` `null` kalır.

## Environment variables

```text
METALS_DEV_API_KEY
COLLECTAPI_TOKEN
GOLD_PROVIDER
GOLD_CACHE_TTL_MS
GOLD_REQUEST_TIMEOUT_MS
GOLD_MAX_RESPONSE_BYTES
GOLD_STALE_MAX_AGE_MS
COLLECTAPI_CACHE_TTL_MS
COLLECTAPI_REQUEST_TIMEOUT_MS
COLLECTAPI_MAX_RESPONSE_BYTES
COLLECTAPI_STALE_MAX_AGE_MS
PORT
NODE_ENV
NEWS_API_KEY
```

Örnek placeholder değerler `.env.example` dosyasındadır. Proje `.env` dosyasını otomatik yüklemez; değerleri çalışma veya hosting ortamında tanımlayın. `.env` ve `.env.*` Git tarafından yok sayılır, `.env.example` izlenebilir.

## Güvenilirlik ve güvenlik

- Her iki provider için varsayılan fiyat cache süresi 60 saniyedir.
- Eşzamanlı cache miss istekleri tek harici istekte birleştirilir.
- Son başarılı veri ilgili provider'ın stale yaş sınırı içinde sunulur.
- 401/403 yapılandırma hataları ve 429 kota cevapları kontrollü backoff uygular.
- Provider isteklerinde timeout ve stream tabanlı maksimum response boyutu bulunur.
- API key frontend'e, API response'una ve uygulama loglarına yazılmaz.
- Haber URL'lerinde yalnızca HTTPS kabul edilir; harici metinler `textContent` ile gösterilir.
- CSP, nosniff, referrer, permissions, COOP, frame ve production HSTS başlıkları uygulanır.
- API rotalarında in-memory rate limit ve HTTP method allowlist bulunur.

## Komutlar

```powershell
npm test
npm run verify:bist
npm start
```

`npm test` tamamen mock verilerle çalışır ve harici API isteği göndermez. `npm run verify:bist` gerçek Borsa İstanbul endpoint'ine bağlandığı için yalnızca development doğrulaması amacıyla bilinçli olarak çalıştırılmalıdır.

## Endpointler

- `GET /api/prices`
- `GET /api/news`
- `GET` veya `HEAD /health`
- `GET` veya `HEAD /` ve diğer statik dosyalar

Desteklenmeyen HTTP metotları `405 Method Not Allowed`; eksik provider yapılandırması veya kullanılamayan fiyat kaynağı `503 Service Unavailable` döndürür.
