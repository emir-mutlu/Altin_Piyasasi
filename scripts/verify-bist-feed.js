const { BistGoldProvider } = require('../services/bist-gold-provider');

async function main() {
  const payload = await new BistGoldProvider().getPrices();
  const summary = {
    source: payload.source,
    sourceType: payload.sourceType,
    sourceDate: payload.sourceDate,
    fetchedAt: payload.fetchedAt,
    freshness: payload.freshness,
    warning: payload.warning,
    rows: payload.rows.map((row) => ({
      code: row.code,
      reference: row.reference,
      currency: row.currency,
      isEstimated: row.isEstimated,
    })),
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch(() => {
  process.stderr.write('Borsa İstanbul resmi XML verisi doğrulanamadı.\n');
  process.exitCode = 1;
});
