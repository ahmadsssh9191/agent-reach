// Order status for a customer, read-only, through the WooCommerce REST API.
// She must give the order number AND the last 4 digits of the phone she
// ordered with; nothing is returned otherwise (privacy).

const SITE = "https://hausofit.co.il";

const STATUS = {
  pending: "waiting for payment",
  processing: "received, being prepared",
  "on-hold": "on hold (usually waiting for a bank transfer or a check by the team)",
  shipped: "left the warehouse, on its way with the courier",
  completed: "delivered",
  cancelled: "cancelled",
  refunded: "refunded",
  failed: "payment failed",
};

const digits = (s) => String(s || "").replace(/\D/g, "");

export async function orderStatus(env, orderNumber, phoneLast4) {
  if (!env.WC_KEY || !env.WC_SECRET) return { found: false, reason: "order lookup is not set up" };
  const id = Number(digits(orderNumber));
  const last4 = digits(phoneLast4).slice(-4);
  if (!id || last4.length !== 4) return { found: false, reason: "need the order number and the last 4 digits of her phone" };

  const url = `${SITE}/wp-json/wc/v3/orders/${id}?consumer_key=${encodeURIComponent(env.WC_KEY)}&consumer_secret=${encodeURIComponent(env.WC_SECRET)}`;
  const res = await fetch(url, { headers: { "User-Agent": "HausofitDMAgent/1.0" } });
  if (res.status === 404) return { found: false, reason: "no order with this number" };
  if (!res.ok) throw new Error(`woocommerce ${res.status}`);
  const o = await res.json();

  if (digits(o.billing?.phone).slice(-4) !== last4 && digits(o.shipping?.phone).slice(-4) !== last4) {
    // Same answer as "not found", so nobody can probe other people's orders.
    return { found: false, reason: "order number and phone do not match" };
  }

  const meta = Object.fromEntries((o.meta_data || []).map((m) => [m.key, m.value]));
  const tracking = meta._delgo_delivery_id ? String(meta._delgo_delivery_id) : null;
  return {
    found: true,
    order_number: o.number || o.id,
    status: STATUS[o.status] || o.status,
    ordered_on: (o.date_created || "").slice(0, 10),
    shipped_on: meta._hof_shipped_at ? String(meta._hof_shipped_at).slice(0, 10) : null,
    items: (o.line_items || []).map((li) => `${li.name} x${li.quantity}`),
    total_ils: Number(o.total),
    payment: o.payment_method_title || "",
    shipping: (o.shipping_lines || []).map((s) => s.method_title).join(", "),
    tracking_link: tracking ? `${SITE}/order-tracking/?tracking=${encodeURIComponent(tracking)}` : null,
  };
}
