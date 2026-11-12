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
    getAll("_fields=id,name,type,prices,is_in_stock,attributes,images"),
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
      const item = {
        id: p.id,
        name: p.name,
        price_ils: now,
        old_price_ils: was && was !== now ? was : null,
        in_stock: Boolean(p.is_in_stock),
        link: `${SITE}/?p=${p.id}`,
      };
      // Main photo (not shown to the model; used by attach_photo).
      Object.defineProperty(item, "image", { value: p.images?.[0]?.src || null, enumerable: false });
      if (stockByParent[p.id]) {
        item.sizes_colours = stockByParent[p.id];
      } else {
        // Sizes kept by the shop's size plugin: list them, stock via check_sizes.
        const sizes = (p.attributes || [])
          .filter((a) => /מיד/.test(a.name))
          .map((a) => `${a.name}: ${(a.terms || []).map((t) => t.name).join("/")}`);
        if (sizes.length) item.sizes_offered = sizes;
        item.size_stock = "call check_sizes";
      }
      items.push(item);
    }
  }
  cache = { at: Date.now(), items };
  return items;
}

// Stock per size for products that keep sizes in the shop's size plugin.
// Reads the product page (data-stock on each size button).
export async function checkSizes(productId) {
  const res = await fetch(`${SITE}/?p=${Number(productId)}`, {
    headers: { "User-Agent": "HausofitDMAgent/1.0" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`page ${res.status}`);
  const html = await res.text();
  const start = html.indexOf('class="asaf-product-size-groups');
  if (start < 0) return { product_id: productId, sizes: "no size choice on this product" };
  const end = html.indexOf("<section", start);
  const block = html.slice(start, end > start ? end : start + 20000);
  const groups = {};
  for (const g of block.split('class="asaf-size-group"').slice(1)) {
    const title = (g.match(/asaf-size-title">([^<]+)</) || [])[1] || "size";
    const sizes = {};
    for (const m of g.matchAll(/value="([^"]+)"\s+data-stock="(\d+)"/g)) {
      const n = Number(m[2]);
      sizes[m[1]] = n === 0 ? "sold out" : n <= 2 ? "1-2 left" : "in stock";
    }
    groups[title.trim()] = sizes;
  }
  // The size table (measurements in cm) from the same page, as plain rows.
  const size_table = [];
  const t0 = html.indexOf('class="leos-psg"');
  if (t0 > 0) {
    const table = html.slice(t0, html.indexOf("</table>", t0));
    for (const row of table.split("<tr").slice(1)) {
      const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
      if (cells.length) size_table.push(cells.join(" | "));
    }
  }
  return { product_id: productId, sizes: groups, size_table_cm: size_table.slice(0, 12) };
}
