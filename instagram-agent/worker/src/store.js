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

// ---- Size finder: the same calculation as the site's "רוצה עזרה במידה שלך?"
// (hof-fit) on every product page, ported from its script.

const ORDER = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL"];
const textOf = (s) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();

function parseSizeTable(html) {
  const start = html.indexOf('class="leos-psg"');
  if (start < 0) return null;
  const end = html.indexOf("</section>", start);
  const sec = html.slice(start, end > start ? end : start + 30000);
  const title = textOf((sec.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/) || [])[1] || "");
  const rows = [...sec.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => textOf(c[1])),
  );
  if (rows.length < 2) return null;
  const sizes = rows[0].slice(1).map((s) => s.toUpperCase());
  const parts = {};
  const order = [];
  for (const r of rows.slice(1)) {
    let label = r[0];
    let part = "main";
    const sp = label.split(" — ");
    if (sp.length > 1) {
      part = sp[0].trim();
      label = sp.slice(1).join(" — ");
    }
    const isBra = /BRA|גוזי|חזיי|כתפ/i.test(part !== "main" ? part : title);
    const m = /חזה/.test(label) ? "bust" : /מותן/.test(label) ? "waist" : /ירך/.test(label) ? "hip"
      : isBra && /תחתון/.test(label) && !/פתח/.test(label) ? "under" : null;
    if (!m) continue;
    if (!parts[part]) {
      parts[part] = {};
      order.push(part);
    }
    parts[part][m] = { vals: r.slice(1).map((v) => parseFloat(String(v).replace(",", "."))), body: /גוף/.test(label) };
  }
  return order.length ? { title, sizes, parts, order } : { title, sizes, parts: {}, order: [] };
}

function stretch(title, part, m) {
  const t = part !== "main" ? part : title;
  if (/ג׳קט|JACKET|עליונית/i.test(t)) return 1.1;
  if (m === "under") return 1.16;
  if (m === "bust") return 1.29;
  if (/FLOW/.test(title) && /מכנס|PANTS/i.test(t) && !/מתרחב|FLARE/i.test(t)) return 1.1;
  return 1.18;
}

function byMeasure(tbl, part, meas) {
  const p = tbl.parts[part];
  const picks = [];
  for (const m of ["bust", "under", "waist", "hip"]) {
    if (!meas[m] || !p[m]) continue;
    const f = p[m].body ? 1 : stretch(tbl.title, part, m);
    const vals = p[m].vals.map((v) => v * f);
    const tol = m === "bust" || m === "under" ? 3 : 2;
    let idx = -1;
    for (let i = 0; i < vals.length; i++) {
      if (!isNaN(vals[i]) && vals[i] >= meas[m] - tol) {
        idx = i;
        break;
      }
    }
    picks.push({ i: idx < 0 ? vals.length - 1 : idx, over: idx < 0 && meas[m] > vals[vals.length - 1] + 3 });
  }
  if (!picks.length) return null;
  const i = Math.max(...picks.map((x) => x.i));
  return { size: tbl.sizes[i], mixed: picks.some((x) => x.i !== i), over: picks.some((x) => x.over) };
}

function clampTo(sizes, s) {
  if (sizes.includes(s)) return s;
  const want = ORDER.indexOf(s);
  let best = sizes[0];
  let d = 99;
  for (const x of sizes) {
    const k = ORDER.indexOf(x);
    if (k >= 0 && Math.abs(k - want) < d) {
      d = Math.abs(k - want);
      best = x;
    }
  }
  return best;
}

export async function recommendSize(productId, input) {
  const res = await fetch(`${SITE}/?p=${Number(productId)}`, { headers: { "User-Agent": "HausofitDMAgent/1.0" } });
  if (!res.ok) throw new Error(`page ${res.status}`);
  const tbl = parseSizeTable(await res.text());
  const n = (v) => (Number(v) > 0 ? Number(v) : 0);
  const h = n(input.height_cm);
  const w = n(input.weight_kg);
  const meas = { bust: n(input.bust_cm), waist: n(input.waist_cm), hip: n(input.hip_cm), under: 0 };
  const band = n(input.bra_band);
  const cupd = n(input.bra_cup_diff_cm);
  if (band) {
    meas.under = band;
    if (!meas.bust && cupd) meas.bust = band + cupd;
  }
  const usedMeas = tbl && tbl.order.length && (meas.bust || meas.under || meas.waist || meas.hip);
  if (!usedMeas && !(h && w)) return { result: "need height and weight, a bra size, or at least one body measurement" };

  if (usedMeas) {
    const out = [];
    const flags = { mixed: false, over: false };
    for (const p of tbl.order) {
      const r = byMeasure(tbl, p, meas);
      if (r) {
        out.push({ part: p, size: r.size });
        if (r.mixed) flags.mixed = true;
        if (r.over) flags.over = true;
      }
    }
    if (out.length) {
      const notes = [];
      if (out.length > 1 && out[0].part !== "main") notes.push("different size per piece is possible");
      if (flags.mixed && !band) notes.push("her measurements fall on different sizes; the larger one was chosen");
      if (flags.over) notes.push("bigger than the largest size in the table: suggest talking to the team before ordering");
      notes.push("the fabric stretches and shapes; for a looser feel she can go one size up");
      return { method: "body measurements vs. product size table", sizes: out, notes };
    }
  }

  const ranges = [
    { s: "S", h: [155, 167], w: [50, 58] },
    { s: "M", h: [160, 170], w: [56, 66] },
    { s: "L", h: [165, 178], w: [64, 78] },
    { s: "XL", h: [170, 180], w: [72, 84] },
  ];
  if (tbl && tbl.sizes.includes("XS")) ranges.unshift({ s: "XS", h: [150, 163], w: [42, 51] });
  const matches = ranges.filter((r) => h >= r.h[0] && h <= r.h[1] && w >= r.w[0] && w <= r.w[1]);
  const approximate = matches.length === 0;
  const score = (r) =>
    Math.abs(w - (r.w[0] + r.w[1]) / 2) / (r.w[1] - r.w[0]) + Math.abs(h - (r.h[0] + r.h[1]) / 2) / (r.h[1] - r.h[0]);
  const pick = (approximate ? ranges : matches).slice().sort((a, b) => score(a) - score(b))[0];
  const size = tbl && tbl.sizes.length ? clampTo(tbl.sizes, pick.s) : pick.s;
  const notes = [];
  if (size !== pick.s) notes.push(`this product comes in ${tbl.sizes.join(", ")}`);
  if (approximate) notes.push("her height/weight are outside the reference ranges: this is only an estimate");
  notes.push("for a more exact result she can send body measurements (chest, or waist and hips)");
  return { method: "height and weight ranges", sizes: [{ part: "main", size }], notes };
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
