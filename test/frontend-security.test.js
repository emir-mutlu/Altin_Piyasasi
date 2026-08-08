const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
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
