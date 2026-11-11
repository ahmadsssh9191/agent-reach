// Live product data from the public WooCommerce Store API on hausofit.co.il.

const SITE = "https://hausofit.co.il";
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, items: [] };

async function get(path) {
  const res = await fetch(SITE + path, { headers: { "User-Agent": "HausofitDMAgent/1.0" } });
  if (!res.ok) throw new Error(`store ${res.status} on ${path}`);
  return res.json();
}

function price(p, key) {
  const prices = p.prices || {};
  const raw = prices[key];
  if (raw === undefined || raw === null || raw === "") return null;
  return Number(raw) / 10 ** Number(prices.currency_minor_unit || 0);
}

async function getAll(query) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await get(`/wp-json/wc/store/v1/products?per_page=100&page=${page}&${query}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

// All products with live stock per size/colour. Cached for 5 minutes per Worker instance.
export async function listProducts() {
  if (cache.items.length && Date.now() - cache.at < CACHE_MS) return cache.items;
  const [products, variations] = await Promise.all([
    getAll("_fields=id,name,prices,is_in_stock"),
    getAll("type=variation&_fields=parent,variation,is_in_stock,low_stock_remaining"),
  ]);
  const stockByParent = {};
  for (const v of variations) {
    const left = v.low_stock_remaining;
    const status = !v.is_in_stock ? "sold out" : left != null && left <= 2 ? "1-2 left" : "in stock";
    (stockByParent[v.parent] ||= []).push(`${v.variation}: ${status}`);
  }
  const items = [];
  {
    for (const p of products) {
      const now = price(p, "price");
      const was = price(p, "regular_price");
      items.push({
        id: p.id,
        name: p.name,
        price_ils: now,
        old_price_ils: was && was !== now ? was : null,
        in_stock: Boolean(p.is_in_stock),
        sizes_colours: stockByParent[p.id] || [],
        link: `${SITE}/?p=${p.id}`,
      });
    }
  }
  cache = { at: Date.now(), items };
  return items;
}
