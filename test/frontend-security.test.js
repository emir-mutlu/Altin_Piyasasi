const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  calculateConversion,
  normalizeNewsItem,
  safeHttpsUrl,
} = require('../public/app');

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

test('çevirici yalnızca dokuz hedef ürünü doğru sırada içerir', () => {
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
    ['YARIM', 'Yarım Altın'],
    ['TAM', 'Tam Altın'],
    ['CUMHURIYET', 'Cumhuriyet Altını'],
    ['ATA', 'Ata Altın'],
    ['RESAT', 'Reşat Altını'],
    ['ALTIN_22', '22 Ayar Bilezik'],
  ]);
});

test('çevirici dokuz ürünün gerçek reference fiyatıyla hesap yapar', () => {
  const rows = [
    ['GRAM', 4_500],
    ['ONS', 140_000],
    ['CEYREK', 11_179.93],
    ['YARIM', 22_359.86],
    ['TAM', 44_719.72],
    ['CUMHURIYET', 45_820.5],
    ['ATA', 46_020.75],
    ['RESAT', 46_800.9],
    ['ALTIN_22', 4_110.75],
  ].map(([code, reference]) => ({ code, reference }));

  for (const row of rows) {
    assert.equal(calculateConversion(rows, row.code, 2), row.reference * 2);
  }
  assert.equal(calculateConversion(rows, 'UNKNOWN', 2), null);
});
