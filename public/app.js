const state = {
  prices: [],
  lastPriceLoadAt: 0,
  loadingPrices: false,
  lastNewsLoadAt: 0,
  loadingNews: false,
};

const formatters = {
  TRY: new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }),
  USD: new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }),
};

const numberFormatter = new Intl.NumberFormat("tr-TR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const elements =
  typeof document === "undefined"
    ? {}
    : {
        featuredPrices: document.querySelector("#featuredPrices"),
        priceRows: document.querySelector("#priceRows"),
        refreshButton: document.querySelector("#refreshButton"),
        marketTicker: document.querySelector("#marketTicker"),
        amountInput: document.querySelector("#amountInput"),
        productSelect: document.querySelector("#productSelect"),
        converterOutput: document.querySelector("#converterOutput"),
        newsGrid: document.querySelector("#newsGrid"),
        headlineTicker: document.querySelector("#headlineTicker"),
        goldCanvas: document.querySelector("#goldFlow"),
      };

async function browserFetchWithTimeout(url, options = {}, timeoutMs = 7_000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function fetchApiJson(path) {
  const response = await browserFetchWithTimeout(
    path,
    { cache: "no-store" },
    6_000,
  );
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    if (response.ok) {
      throw new Error("API geçerli JSON döndürmedi", { cause: error });
    }
  }
  if (!response.ok) {
    const error = new Error(`API isteği başarısız: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function currency(value, code) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "—";
  }

  const formatter = formatters[code] || formatters.TRY;
  return formatter.format(value);
}

function hasChange(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function changeClass(change) {
  if (!hasChange(change)) {
    return "";
  }
  return change >= 0 ? "up" : "down";
}

function changeText(change) {
  if (!hasChange(change)) {
    return "—";
  }

  const symbol = change >= 0 ? "↑" : "↓";
  return `${symbol} %${numberFormatter.format(Math.abs(change))}`;
}

function priceLabel(row) {
  if (row.isEstimated || row.type === "theoretical") {
    return "Teorik";
  }
  return row.type === "spot" ? "Spot" : "Piyasa";
}

function rowChangePercent(row) {
  return row.changePercent ?? row.change;
}

function renderFeatured(rows) {
  const featured = rows.filter((row) => row.featured).slice(0, 3);
  elements.featuredPrices.innerHTML = featured
    .map((row) => {
      const changePercent = rowChangePercent(row);
      const change = changeText(changePercent);
      const changeSuffix = change === "—" ? "" : ` · ${change}`;

      return `
        <article class="featured-price">
          <span class="label">${row.name}</span>
          <strong>${currency(row.reference, row.currency)}</strong>
          <small class="${changeClass(changePercent)}">
            ${priceLabel(row)}${changeSuffix}
          </small>
        </article>
      `;
    })
    .join("");
}

function renderPriceTable(rows) {
  elements.priceRows.innerHTML = rows
    .map((row) => `
      <tr>
        <td>
          <span class="product-name">${row.name}</span>
          <span class="product-desc">${row.description}</span>
        </td>
        <td><span class="price-value">${currency(row.buy, row.currency)} / ${currency(row.sell, row.currency)}</span></td>
        <td>
          <span class="change ${changeClass(rowChangePercent(row))}">
            ${changeText(rowChangePercent(row))}
          </span>
        </td>
      </tr>
    `)
    .join("");
}

function renderTicker(rows) {
  const tickerItems = rows
    .map(
      (row) =>
        `<span>${row.name} (${priceLabel(row)}): ${currency(row.reference, row.currency)}</span>`,
    )
    .join("");

  elements.marketTicker.innerHTML = `${tickerItems}${tickerItems}`;
}

function calculateConversion(rows, code, amount) {
  const numericAmount = Number(amount);
  const selected = rows.find((row) => row.code === code);
  return selected && Number.isFinite(selected.reference) && Number.isFinite(numericAmount)
    ? numericAmount * selected.reference
    : null;
}

function renderConverter() {
  const amount = Number(elements.amountInput.value || 0);
  const total = calculateConversion(
    state.prices,
    elements.productSelect.value,
    amount,
  );

  if (!Number.isFinite(total)) {
    elements.converterOutput.value = "—";
    elements.converterOutput.textContent = "—";
    return;
  }

  const selected = state.prices.find(
    (row) => row.code === elements.productSelect.value,
  );
  elements.converterOutput.value = currency(total, selected.currency);
  elements.converterOutput.textContent = currency(total, selected.currency);
}

function applyPricePayload(payload) {
  const isStale = payload.freshness === "stale";
  state.prices = (payload.rows || []).map((row) =>
    isStale ? { ...row, change: null, changePercent: null } : row,
  );

  renderFeatured(state.prices);
  renderPriceTable(state.prices);
  renderTicker(state.prices);
  renderConverter();
}

function renderPriceUnavailable() {
  state.prices = [];
  elements.featuredPrices.innerHTML = Array.from(
    { length: 3 },
    () => `
      <article class="featured-price">
        <span class="label">Spot fiyat</span>
        <strong>—</strong>
        <small>Geçici olarak kullanılamıyor</small>
      </article>
    `,
  ).join("");
  elements.priceRows.innerHTML = `
    <tr>
      <td colspan="3">Altın fiyatları şu anda kullanılamıyor.</td>
    </tr>
  `;
  elements.marketTicker.innerHTML =
    "<span>Spot fiyat verisi bekleniyor</span><span>Spot fiyat verisi bekleniyor</span>";
  renderConverter();
}

async function loadPrices() {
  if (state.loadingPrices) {
    return;
  }
  state.loadingPrices = true;
  elements.refreshButton.disabled = true;

  try {
    applyPricePayload(await fetchApiJson("/api/prices"));
  } catch (error) {
    renderPriceUnavailable();
  } finally {
    state.lastPriceLoadAt = Date.now();
    state.loadingPrices = false;
    elements.refreshButton.disabled = false;
  }
}

function sourceLabel(source) {
  const labels = {
    newsapi: "NewsAPI",
    "google-news": "Google Haberler",
    gdelt: "GDELT",
    fallback: "Yerel haber özeti",
  };

  return labels[source] || source || "Haber";
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : null;
  } catch (error) {
    return null;
  }
}

function normalizeNewsItem(item, source, updatedAt) {
  const publishedCandidate = item?.publishedAt || updatedAt;
  const published = publishedCandidate ? new Date(publishedCandidate) : null;
  return {
    title: String(item?.title || "").trim(),
    source: String(item?.source || sourceLabel(source)).trim(),
    summary: String(
      item?.summary || "Altın ve ekonomi gündeminden son başlık.",
    ).trim(),
    url: safeHttpsUrl(item?.url),
    published:
      published && !Number.isNaN(published.getTime()) ? published : null,
  };
}

function renderNews(items, source, updatedAt) {
  const normalizedItems = items
    .slice(0, 6)
    .map((item) => normalizeNewsItem(item, source, updatedAt))
    .filter((item) => item.title);

  const cards = document.createDocumentFragment();
  for (const item of normalizedItems) {
    const article = document.createElement("article");
    article.className = "news-card";
    const content = document.createElement("div");
    const meta = document.createElement("div");
    meta.className = "news-meta";
    const sourceNode = document.createElement("span");
    sourceNode.textContent = item.source;
    meta.append(sourceNode);

    if (item.published) {
      const time = document.createElement("time");
      time.dateTime = item.published.toISOString();
      time.textContent = dateFormatter.format(item.published);
      meta.append(time);
    }

    const heading = document.createElement("h3");
    if (item.url) {
      const link = document.createElement("a");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = item.title;
      heading.append(link);
    } else {
      heading.textContent = item.title;
    }

    const summary = document.createElement("p");
    summary.textContent = item.summary;
    content.append(meta, heading);
    article.append(content, summary);
    cards.append(article);
  }
  elements.newsGrid.replaceChildren(cards);

  const headlines = document.createDocumentFragment();
  for (const item of normalizedItems.slice(0, 5)) {
    const headline = document.createElement("span");
    headline.textContent = item.title;
    headlines.append(headline);
  }
  elements.headlineTicker.replaceChildren(headlines);
}

function renderNewsUnavailable() {
  const article = document.createElement("article");
  article.className = "news-card";
  const content = document.createElement("div");
  const meta = document.createElement("div");
  meta.className = "news-meta";
  const source = document.createElement("span");
  source.textContent = "Haber akışı";
  const heading = document.createElement("h3");
  heading.textContent = "Haberler geçici olarak alınamıyor";
  const summary = document.createElement("p");
  summary.textContent = "Lütfen daha sonra yeniden deneyin.";
  meta.append(source);
  content.append(meta, heading);
  article.append(content, summary);
  elements.newsGrid.replaceChildren(article);

  const headline = document.createElement("span");
  headline.textContent = "Haber akışı geçici olarak kullanılamıyor.";
  elements.headlineTicker.replaceChildren(headline);
}

async function loadNews() {
  if (state.loadingNews) {
    return;
  }
  state.loadingNews = true;
  try {
    const payload = await fetchApiJson("/api/news");
    if (!payload.items?.length) {
      renderNewsUnavailable();
      return;
    }
    renderNews(payload.items, payload.source, payload.updatedAt);
  } catch (error) {
    renderNewsUnavailable();
  } finally {
    state.lastNewsLoadAt = Date.now();
    state.loadingNews = false;
  }
}

function setupGoldCanvas() {
  const canvas = elements.goldCanvas;
  const context = canvas.getContext("2d", { alpha: true });
  let width = 0;
  let height = 0;
  const frame = 0.008;

  function resize() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(height * pixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    draw();
  }

  function draw() {
    context.clearRect(0, 0, width, height);

    for (let band = 0; band < 8; band += 1) {
      const yBase = (height / 8) * band + Math.sin(frame + band) * 34;
      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "rgba(255, 249, 216, 0.26)");
      gradient.addColorStop(
        0.28,
        `rgba(255, ${224 - band * 4}, 130, ${0.14 + band * 0.008})`,
      );
      gradient.addColorStop(0.68, "rgba(238, 180, 75, 0.06)");
      gradient.addColorStop(1, "rgba(150, 83, 8, 0)");

      context.beginPath();
      context.moveTo(-40, yBase);

      for (let x = -40; x <= width + 40; x += 32) {
        const y =
          yBase +
          Math.sin(x * 0.008 + frame * (1.3 + band * 0.12) + band) *
            (26 + band * 4);
        context.lineTo(x, y);
      }

      context.strokeStyle = gradient;
      context.lineWidth = 22 + band * 2;
      context.stroke();
    }
  }

  resize();
  window.addEventListener("resize", resize);
}

function initializeApp() {
  elements.refreshButton.addEventListener("click", loadPrices);
  elements.amountInput.addEventListener("input", renderConverter);
  elements.productSelect.addEventListener("change", renderConverter);

  setupGoldCanvas();
  loadPrices();
  loadNews();

  window.setInterval(() => {
    if (!document.hidden) {
      loadPrices();
    }
  }, 60_000);
  window.setInterval(() => {
    if (!document.hidden) {
      loadNews();
    }
  }, 120_000);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      return;
    }
    const now = Date.now();
    if (now - state.lastPriceLoadAt >= 60_000) {
      loadPrices();
    }
    if (now - state.lastNewsLoadAt >= 120_000) {
      loadNews();
    }
  });
}

if (typeof document !== "undefined") {
  initializeApp();
}

if (typeof module !== "undefined") {
  module.exports = {
    calculateConversion,
    changeClass,
    changeText,
    normalizeNewsItem,
    rowChangePercent,
    safeHttpsUrl,
  };
}
