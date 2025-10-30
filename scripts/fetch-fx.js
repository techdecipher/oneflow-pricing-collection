// Fetch USD FX rates and write data/fx.json
// Source: open.er-api.com (no key). You can swap later to ECB/your source.
const fs = require('fs');
const path = require('path');

(async () => {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) throw new Error(`FX fetch failed: ${res.status}`);
    const json = await res.json();

    const pick = (c) => Number(json?.rates?.[c] || (c === 'USD' ? 1 : null));
    const fx = {
      updated_at: new Date().toISOString(),
      USD: 1,
      INR: pick('INR'),
      EUR: pick('EUR'),
      GBP: pick('GBP')
    };

    fs.writeFileSync(
      path.join('data', 'fx.json'),
      JSON.stringify(fx, null, 2)
    );
    console.log('fx.json written');
  } catch (e) {
    console.error('FX error, writing fallback:', e.message);
    fs.writeFileSync(
      path.join('data', 'fx.json'),
      JSON.stringify({ updated_at: new Date().toISOString(), USD: 1, INR: 83, EUR: 0.92, GBP: 0.78 }, null, 2)
    );
  }
})();
