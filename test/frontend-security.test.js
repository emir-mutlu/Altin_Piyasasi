const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  calculateConversion,
  changeClass,
  changeText,
  normalizeNewsItem,
  rowChangePercent,
  safeHttpsUrl,
} = require('../public/app');

test('değişim formatı pozitif, negatif ve sıfır yüzdeleri mevcut UI biçiminde gösterir', () => {
  assert.equal(changeText(1.27), '↑ %1,27');
  assert.equal(changeClass(1.27), 'up');
  assert.equal(changeText(-0.46), '↓ %0,46');
  assert.equal(changeClass(-0.46), 'down');
  assert.equal(changeText(0), '↑ %0,00');
  assert.equal(changeClass(0), 'up');
  assert.equal(changeText(null), '—');
  assert.equal(rowChangePercent({ changePercent: 0, change: 99 }), 0);
});

test('haber başlığındaki script etiketi yalnızca metin olarak korunur', () => {
  const title = '<script>globalThis.compromised = true</script>';
  const item = normalizeNewsItem(
    { title, summary: '<img src=x onerror=alert(1)>', url: 'https://example.com/news' },
    'test',
    null,
  );
  assert.equal(item.title, title);
  assert.equal(item.summary, '<img src=x onerror=alert(1)>');
});

test('javascript, data, file ve http haber URLlerini reddeder', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'http://example.com/news',
  ]) {
    assert.equal(safeHttpsUrl(url), null);
  }
});

test('yalnızca geçerli https haber URLlerine izin verir', () => {
  assert.equal(
    safeHttpsUrl('https://example.com/news?id=1'),
    'https://example.com/news?id=1',
  );
  assert.equal(safeHttpsUrl('not a url'), null);
});

test('renderNews harici verileri innerHTML ile birleştirmez', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8',
  );
  const renderNewsSource = source.slice(
    source.indexOf('function renderNews('),
    source.indexOf('function renderNewsUnavailable('),
  );
  assert.doesNotMatch(renderNewsSource, /innerHTML/);
  assert.match(renderNewsSource, /document\.createElement/);
  assert.match(renderNewsSource, /textContent/);
});

test('production localhost API fallbackı bulunmaz', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /http:\/\/localhost:3000/);
  assert.match(source, /fetchApiJson\("\/api\/prices"\)/);
});

test('CollectAPI endpointi ve tokenı frontend kaynaklarında bulunmaz', () => {
  for (const filename of ['app.js', 'index.html']) {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'public', filename),
      'utf8',
    );
    assert.doesNotMatch(source, /api\.collectapi\.com|COLLECTAPI_TOKEN|apikey\s/i);
  }
});

test('görünür fiyat metadata ve gecikme uyarısı tamamen kaldırılmıştır', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'index.html'),
    'utf8',
  );
  const app = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8',
  );
  const visibleSource = `${html}\n${app}`;

  assert.doesNotMatch(visibleSource, /Kaynak:/);
  assert.doesNotMatch(visibleSource, /Son veri zamanı:/);
  assert.doesNotMatch(visibleSource, /Veriler yaklaşık 1-2 dakika/);
  assert.doesNotMatch(html, /class="terminal-foot"|id="priceSource"|id="priceUpdated"/);
});

test('fiyat tablosu yalnızca Ürün, Alış / Satış ve Değişim kolonlarını gösterir', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'index.html'),
    'utf8',
  );
  const app = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8',
  );
  const tableHead = html.slice(
    html.indexOf('<thead>'),
    html.indexOf('</thead>') + '</thead>'.length,
  );
  const headers = [...tableHead.matchAll(/<th scope="col">([^<]+)<\/th>/g)]
    .map((match) => match[1]);
  const renderPriceTableSource = app.slice(
    app.indexOf('function renderPriceTable('),
    app.indexOf('function renderTicker('),
  );

  assert.deepEqual(headers, ['Ürün', 'Alış / Satış', 'Değişim']);
  assert.equal((renderPriceTableSource.match(/<td>/g) || []).length, 3);
  assert.doesNotMatch(renderPriceTableSource, /currency\(row\.reference/);
  assert.match(renderPriceTableSource, /currency\(row\.buy/);
  assert.match(renderPriceTableSource, /currency\(row\.sell/);
  assert.match(renderPriceTableSource, /changeText\(rowChangePercent\(row\)\)/);
});

test('çevirici on iki hedef ürünü doğru sırada içerir', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'index.html'),
    'utf8',
  );
  const select = html.slice(
    html.indexOf('<select id="productSelect">'),
    html.indexOf('</select>', html.indexOf('<select id="productSelect">')),
  );
  const options = [...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
    .map((match) => [match[1], match[2]]);

  assert.deepEqual(options, [
    ['GRAM', 'Gram Altın'],
    ['ONS', 'Ons Altın'],
    ['CEYREK', 'Çeyrek Altın'],
    ['CEYREK_ESKI', 'Eski Çeyrek Altın'],
    ['YARIM', 'Yarım Altın'],
    ['YARIM_ESKI', 'Eski Yarım Altın'],
    ['TAM', 'Tam Altın'],
    ['TAM_ESKI', 'Eski Tam Altın'],
    ['CUMHURIYET', 'Cumhuriyet Altını'],
    ['ATA', 'Ata Altın'],
    ['RESAT', 'Reşat Altını'],
    ['ALTIN_22', '22 Ayar Bilezik'],
  ]);
});

test('çevirici mevcut dokuz ve yeni üç ürünün reference fiyatıyla miktar 1 ve 2 hesaplar', () => {
  const rows = [
    ['GRAM', 4_500],
    ['ONS', 140_000],
    ['CEYREK', 11_179.93],
    ['CEYREK_ESKI', 11_050.5],
    ['YARIM', 22_359.86],
    ['YARIM_ESKI', 22_100.25],
    ['TAM', 44_719.72],
    ['TAM_ESKI', 44_200.5],
    ['CUMHURIYET', 45_820.5],
    ['ATA', 46_020.75],
    ['RESAT', 46_800.9],
    ['ALTIN_22', 4_110.75],
  ].map(([code, reference]) => ({ code, reference }));

  for (const row of rows) {
    assert.equal(calculateConversion(rows, row.code, 1), row.reference);
    assert.equal(calculateConversion(rows, row.code, 2), row.reference * 2);
  }
  assert.equal(calculateConversion(rows, 'UNKNOWN', 2), null);
});
