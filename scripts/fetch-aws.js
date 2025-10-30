const fs = require('fs');
const path = require('path');
const regions = require('./regions-aws');

// Choose which regions you want to publish
const TARGET_REGIONS = ['ap-south-1', 'us-east-1'];

function out(p) { return path.join('data', 'cloud', p); }

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function fetchEC2Region(regionCode) {
  // AWS price list for the region
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${regionCode}/index.json`;
  const j = await fetchJSON(url);
  const outRows = [];

  for (const [sku, prod] of Object.entries(j.products || {})) {
    if ((prod.productFamily || '') !== 'Compute Instance') continue;
    const a = prod.attributes || {};
    // Basic filters: Linux, Shared, non-Reserved
    if (a.operatingSystem !== 'Linux') continue;
    if (a.tenancy !== 'Shared') continue;
    if (a.preInstalledSw && a.preInstalledSw !== 'NA') continue;
    if (a.capacitystatus && a.capacitystatus !== 'Used') continue;

    // On-demand terms → pricePerUnit.USD
    const terms = j.terms?.OnDemand?.[sku];
    if (!terms) continue;
    let usdPerHour = null;
    for (const t of Object.values(terms)) {
      for (const pd of Object.values(t.priceDimensions || {})) {
        usdPerHour = Number(pd.pricePerUnit?.USD ?? 0);
        if (usdPerHour) break;
      }
      if (usdPerHour) break;
    }
    if (!usdPerHour) continue;

    // vCPU / memory parsing is present in attributes
    const vcpu = Number(a.vcpu ?? 0);
    let ramGB = null;
    if (a.memory) {
      const m = String(a.memory).match(/([\d.]+)\s*GiB/i);
      if (m) ramGB = Number(m[1]);
    }

    outRows.push({
      provider: 'aws',
      region: regionCode,
      type: a.instanceType,
      vCPU: vcpu || null,
      RAM_GB: ramGB,
      usd_per_hour: usdPerHour
    });
  }
  return outRows.sort((x, y) => x.type.localeCompare(y.type));
}

async function fetchS3Pricing() {
  // Storage: S3 Standard first-tier GB-month (us-east-1 file contains global S3 skus)
  const url = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/index.json';
  const j = await fetchJSON(url);

  // Very simplified: pick a common "Amazon S3" storage GB-month SKU price
  // Fallback to a safe default if not found.
  let usdPerGbMonth = 0.023; // fallback common list price
  try {
    const sku = Object.keys(j.products).find(k => {
      const p = j.products[k];
      return p.productFamily === 'Storage' &&
             /Amazon S3/.test(p.attributes?.storageClass || '') &&
             /Standard/.test(p.attributes?.storageClass || '');
    });
    if (sku && j.terms?.OnDemand?.[sku]) {
      const term = Object.values(j.terms.OnDemand[sku])[0];
      const pd = Object.values(term.priceDimensions)[0];
      const price = Number(pd.pricePerUnit?.USD);
      if (price) usdPerGbMonth = price;
    }
  } catch (_) {}

  // Egress (Data Transfer OUT-Internet) per GB — simplified 1st tier
  const urlDt = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/index.json';
  const d = await fetchJSON(urlDt);
  let usdPerGbEgress = 0.09; // fallback common first tier
  try {
    const sku = Object.keys(d.products).find(k => {
      const p = d.products[k];
      return p.productFamily === 'Data Transfer' &&
             /Internet Out/.test(p.attributes?.usagetype || '') &&
             /AWS Outbound Data Transfer/.test(p.attributes?.group || '');
    });
    if (sku && d.terms?.OnDemand?.[sku]) {
      const term = Object.values(d.terms.OnDemand[sku])[0];
      const pd = Object.values(term.priceDimensions)[0];
      const price = Number(pd.pricePerUnit?.USD);
      if (price) usdPerGbEgress = price;
    }
  } catch (_) {}

  return { usdPerGbMonth, usdPerGbEgress };
}

(async () => {
  try {
    const tasks = TARGET_REGIONS.map(fetchEC2Region);
    const all = (await Promise.all(tasks)).flat();

    // Write instances.json
    fs.writeFileSync(out('instances.json'), JSON.stringify(all, null, 2));
    console.log(`instances.json (${all.length} rows)`);

    const s3 = await fetchS3Pricing();

    // Write storage.json
    fs.writeFileSync(out('storage.json'), JSON.stringify([
      { provider: 'aws', usd_per_gb_month: s3.usdPerGbMonth },
      // Placeholders for future (UI can show multiple providers)
      { provider: 'gcp', usd_per_gb_month: 0.02 },
      { provider: 'azure', usd_per_gb_month: 0.02 }
    ], null, 2));
    console.log('storage.json');

    // Write egress.json
    fs.writeFileSync(out('egress.json'), JSON.stringify([
      { provider: 'aws', usd_per_gb: s3.usdPerGbEgress },
      // Rough placeholders (replace when you add real fetchers)
      { provider: 'gcp', usd_per_gb: 0.085 },
      { provider: 'azure', usd_per_gb: 0.087 }
    ], null, 2));
    console.log('egress.json');

  } catch (e) {
    console.error('AWS fetch failed:', e);
    process.exit(1);
  }
})();
