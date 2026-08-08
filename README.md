# altinpiyasasi.com

Vanilla HTML, CSS ve JavaScript frontend ile yerleşik `node:http` backend kullanan global spot altın piyasası uygulaması.

## Gereksinimler

- Node.js 18 veya üzeri
- Production fiyat akışı için Metals.dev API key

## Yerel çalıştırma

```powershell
npm ci
$env:METALS_DEV_API_KEY="your_metals_dev_api_key"
$env:GOLD_PROVIDER="metals_dev"
npm start
```

Ardından `http://localhost:3000` adresini açın. PowerShell execution policy `npm` komutunu engelliyorsa `npm.cmd ci`, `npm.cmd test` ve `npm.cmd start` kullanın.

API key yokken sunucu ve `/health` çalışır; `/api/prices` güvenli biçimde HTTP 503 döndürür ve demo fiyat üretmez.

## Fiyat sağlayıcıları

Production varsayılanı `metals_dev` provider'ıdır. Backend yalnızca sabit `https://api.metals.dev/v1/metal/spot` endpoint'ine bağlanır ve `metal=gold`, `currency=TRY` parametrelerini kullanır.

`GOLD_PROVIDER=bist` yalnızca development ortamında açıkça seçilebilen eski resmî referans provider'ıdır. Metals.dev hatasında BIST'e otomatik fallback yapılmaz.

## Fiyat sınıfları

- Gram Altın: Metals.dev global spot TRY/gram.
- Ons Altın: Metals.dev global spot TRY/troy ounce.
- Çeyrek Ziynet: Darphane ağırlık ve saflık değerleriyle teorik hesaplama.
- Birlik Cumhuriyet Ziynet: Darphane ağırlık ve saflık değerleriyle teorik hesaplama.
- ATA / Cumhuriyet Sikke: Darphane ağırlık ve saflık değerleriyle teorik hesaplama.

Teorik ürünlerde gerçek perakende alış/satış üretilmez; `buy` ve `sell` alanları `null` kalır.

## Environment variables

```text
METALS_DEV_API_KEY
GOLD_PROVIDER
GOLD_CACHE_TTL_MS
GOLD_REQUEST_TIMEOUT_MS
GOLD_MAX_RESPONSE_BYTES
GOLD_STALE_MAX_AGE_MS
PORT
NODE_ENV
NEWS_API_KEY
```

Örnek placeholder değerler `.env.example` dosyasındadır. Proje `.env` dosyasını otomatik yüklemez; değerleri çalışma veya hosting ortamında tanımlayın. `.env` ve `.env.*` Git tarafından yok sayılır, `.env.example` izlenebilir.

## Güvenilirlik ve güvenlik

- Varsayılan fiyat cache süresi 60 saniyedir.
- Eşzamanlı cache miss istekleri tek harici istekte birleştirilir.
- Son başarılı veri yalnızca `GOLD_STALE_MAX_AGE_MS` sınırı içinde stale olarak sunulur.
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
