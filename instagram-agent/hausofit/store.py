"""Live product data from the public WooCommerce Store API on hausofit.co.il."""

import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

SITE = "https://hausofit.co.il"
_cache = {"at": 0.0, "items": []}
CACHE_SECONDS = 600


def _get(path: str):
    req = urllib.request.Request(SITE + path, headers={"User-Agent": "HausofitDMAgent/1.0"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode("utf-8"))


def _price(p: dict, key: str):
    prices = p.get("prices") or {}
    raw = prices.get(key)
    if raw in (None, ""):
        return None
    unit = int(prices.get("currency_minor_unit") or 0)
    value = int(raw) / (10 ** unit)
    return int(value) if value == int(value) else value


def list_products() -> list:
    """All products, short form. Cached for 10 minutes."""
    if _cache["items"] and time.time() - _cache["at"] < CACHE_SECONDS:
        return _cache["items"]
    items, page = [], 1
    while page <= 3:
        batch = _get(f"/wp-json/wc/store/v1/products?per_page=100&page={page}")
        if not batch:
            break
        for p in batch:
            price, regular = _price(p, "price"), _price(p, "regular_price")
            items.append({
                "id": p["id"],
                "name": p.get("name", ""),
                "price_ils": price,
                "old_price_ils": regular if regular and regular != price else None,
                "in_stock": bool(p.get("is_in_stock")),
                "options": {a["name"]: [t["name"] for t in a.get("terms", [])]
                            for a in p.get("attributes", []) if a.get("has_variations")},
                "link": f"{SITE}/?p={p['id']}",
            })
        if len(batch) < 100:
            break
        page += 1
    _cache.update(at=time.time(), items=items)
    return items


def product_sizes(product_id: int) -> dict:
    """Which size/colour combinations of one product are in stock right now."""
    p = _get(f"/wp-json/wc/store/v1/products/{int(product_id)}")
    out = {"id": p["id"], "name": p.get("name", ""), "variants": []}
    variations = (p.get("variations") or [])[:40]

    def fetch(v):
        try:
            return _get(f"/wp-json/wc/store/v1/products/{v['id']}")
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=10) as pool:
        details = list(pool.map(fetch, variations))
    for v, vp in zip(variations, details):
        if vp is None:
            continue
        left = vp.get("low_stock_remaining")
        out["variants"].append({
            "options": {a["name"]: a["value"] for a in v.get("attributes", [])},
            "in_stock": bool(vp.get("is_in_stock")),
            "few_left": bool(left is not None and left <= 2),
        })
    return out
