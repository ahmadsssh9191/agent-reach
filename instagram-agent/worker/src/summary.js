// Conversation summaries for the owner, by email (Resend).
// Each ManyChat conversation is tracked in KV (binding CONVOS). A cron every
// 10 minutes emails a summary once the customer has been quiet for 30 minutes.
// Hand-offs are emailed right away.

import Anthropic from "@anthropic-ai/sdk";

const QUIET_MS = 30 * 60 * 1000;
const KEY = (id) => `conv:${id}`;

export async function trackMessage(env, id, info) {
  if (!env.CONVOS) return;
  const key = KEY(id);
  const conv = (await env.CONVOS.get(key, "json")) || { id, start: Date.now(), messages: [], handoff: false };
  conv.name = info.name || conv.name;
  conv.username = info.username || conv.username;
  conv.chatUrl = info.chatUrl || conv.chatUrl;
  conv.last = Date.now();
  conv.messages.push({ who: "customer", text: info.text });
  if (info.reply) conv.messages.push({ who: "shop", text: info.reply });
  if (info.silent) conv.messages.push({ who: "shop", text: "(no reply: out of scope)" });
  conv.messages = conv.messages.slice(-30);
  if (info.handoff) {
    conv.handoff = true;
    conv.handoffReason = info.reason || "";
  }
  await env.CONVOS.put(key, JSON.stringify(conv), { expirationTtl: 7 * 24 * 3600 });
  if (info.handoff) await sendSummary(env, conv, true).catch((e) => console.log(`handoff email: ${e.message}`));
}

// Cron: summarise conversations that went quiet.
export async function flushQuiet(env) {
  if (!env.CONVOS) return;
  const list = await env.CONVOS.list({ prefix: "conv:" });
  for (const k of list.keys) {
    const conv = await env.CONVOS.get(k.name, "json");
    if (!conv || Date.now() - conv.last < QUIET_MS) continue;
    try {
      await sendSummary(env, conv, false);
      await recordStats(env, conv).catch((e) => console.log(`stats ${k.name}: ${e.message}`));
      await env.CONVOS.delete(k.name);
    } catch (e) {
      console.log(`summary email ${k.name}: ${e.message}`);
    }
  }
}

async function summarise(env, conv) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 });
  const chat = conv.messages.map((m) => `${m.who === "customer" ? "الزبونة" : "المحل"}: ${m.text}`).join("\n");
  const r = await client.messages.create({
    model: env.CLAUDE_PROFILE_MODEL || "claude-haiku-5-5",
    max_tokens: 1024,
    output_config: { effort: "low" },
    system:
      "اكتب لصاحب محل ملابس رياضية نسائية ملخص قصير بالعربي المحكي لمحادثة انستغرام بين زبونة ومساعد المحل. " +
      "3 لـ 5 أسطر بسيطة: مين الزبونة، شو سألت عنه (قطعة، لون، مقاس)، شو جاوبناها، إذا أخدت رابط، " +
      "وشو الخطوة الجاية إذا في (مثلاً: لسا ما طلبت، بدها ترجع، لازم ترد عليها انت). " +
      "بدون مقدمات ولا عناوين ولا رموز، الحقائق بس.",
    messages: [{ role: "user", content: `اسم الزبونة: ${conv.name || "غير معروف"}\n\n${chat}` }],
  });
  return r.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// ---- Weekly report ----------------------------------------------------------
// After each finished conversation: a small record in KV (kept 21 days).

async function recordStats(env, conv) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 });
  const chat = conv.messages.map((m) => `${m.who === "customer" ? "Customer" : "Shop"}: ${m.text}`).join("\n");
  const r = await client.messages.create({
    model: env.CLAUDE_PROFILE_MODEL || "claude-haiku-5-5",
    max_tokens: 1024,
    output_config: { effort: "low" },
    system:
      "Read this Instagram DM chat between a customer and a women's activewear shop. Answer with JSON only, no other text: " +
      '{"topics": [up to 3 short English labels from: price, size help, stock, shipping, returns, order status, payment, fabric/care, new items, complaint, other], ' +
      '"items_asked": [short English item names she asked about, with colour], ' +
      '"not_available": [items/colours/sizes she wanted that were sold out or not sold, e.g. "olive FLOW pants M"], ' +
      '"outcome": one of "cart link sent", "product link sent", "handed to team", "just asked", "no reply needed"}',
    messages: [{ role: "user", content: chat }],
  });
  const raw = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let stats = {};
  try {
    stats = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    stats = {};
  }
  stats.cart = conv.messages.some((m) => /hof_cart=/.test(m.text || ""));
  stats.handoff = Boolean(conv.handoff);
  stats.at = conv.last || Date.now();
  await env.CONVOS.put(`stat:${stats.at}:${conv.id}`, JSON.stringify(stats), { expirationTtl: 21 * 24 * 3600 });
}

async function agentOrders(env, sinceIso) {
  if (!env.WC_KEY || !env.WC_SECRET) return null;
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const url =
      `https://hausofit.co.il/wp-json/wc/v3/orders?after=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}` +
      `&consumer_key=${encodeURIComponent(env.WC_KEY)}&consumer_secret=${encodeURIComponent(env.WC_SECRET)}`;
    const res = await fetch(url, { headers: { "User-Agent": "HausofitDMAgent/1.0" } });
    if (!res.ok) throw new Error(`woocommerce ${res.status}`);
    const batch = await res.json();
    for (const o of batch) {
      const src = (o.meta_data || []).find((m) => m.key === "_hof_order_source")?.value;
      if (src === "instagram_dm_agent") out.push({ number: o.number, status: o.status, total: Number(o.total) });
    }
    if (batch.length < 100) break;
  }
  return out;
}

export async function sendWeeklyReport(env) {
  if (!env.CONVOS || !env.RESEND_API_KEY || !env.SUMMARY_EMAIL_TO) return;
  const since = Date.now() - 7 * 24 * 3600 * 1000;
  const list = await env.CONVOS.list({ prefix: "stat:" });
  const stats = [];
  for (const k of list.keys) {
    const at = Number(k.name.split(":")[1]);
    if (at >= since) stats.push(await env.CONVOS.get(k.name, "json"));
  }
  const count = (arr) => {
    const m = {};
    for (const x of arr) m[x] = (m[x] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10);
  };
  const data = {
    conversations: stats.length,
    cart_links_sent: stats.filter((s) => s?.cart).length,
    handed_to_team: stats.filter((s) => s?.handoff).length,
    top_topics: count(stats.flatMap((s) => s?.topics || [])),
    top_items_asked: count(stats.flatMap((s) => s?.items_asked || [])),
    wanted_but_not_available: count(stats.flatMap((s) => s?.not_available || [])),
    outcomes: count(stats.map((s) => s?.outcome).filter(Boolean)),
  };
  let orders = null;
  try {
    orders = await agentOrders(env, new Date(since).toISOString().slice(0, 19));
  } catch (e) {
    console.log(`weekly orders: ${e.message}`);
  }
  if (orders) {
    data.orders_from_agent = orders.length;
    data.revenue_from_agent_ils = orders.filter((o) => !["cancelled", "failed", "refunded"].includes(o.status)).reduce((a, o) => a + o.total, 0);
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 });
  const r = await client.messages.create({
    model: env.CLAUDE_PROFILE_MODEL || "claude-haiku-5-5",
    max_tokens: 2048,
    output_config: { effort: "low" },
    system:
      "اكتب لصاحب محل ملابس رياضية نسائية تقرير أسبوعي قصير بالعربي المحكي عن رسائل الانستغرام اللي رد عليها الايجينت. " +
      "استعمل الأرقام بس من البيانات. أقسام قصيرة: الأرقام الأساسية، شو سألوا أكتر، أكتر قطع انسألوا عنها، " +
      "شو طلبوا وما كان موجود (وهاد مهم لقرار شو ينزّل من المصنع)، ونصيحة وحدة أو تنتين عملية. " +
      "إذا ما في طلبيات من الايجينت أو ما في بيانات طلبيات، احكي هيك بوضوح. بدون مبالغة. نص عادي، كل سطر فكرة.",
    messages: [{ role: "user", content: JSON.stringify(data) }],
  });
  const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.7;max-width:640px">${esc(text).replace(/\n/g, "<br>")}</div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.SUMMARY_EMAIL_FROM || "Hausofit DM agent <onboarding@resend.dev>",
      to: [env.SUMMARY_EMAIL_TO],
      subject: `📊 تقرير الانستغرام الأسبوعي: ${data.conversations} محادثة`,
      html,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export async function sendSummary(env, conv, urgent) {
  if (!env.RESEND_API_KEY || !env.SUMMARY_EMAIL_TO) throw new Error("email not configured");
  const summary = await summarise(env, conv);
  const who = conv.name || conv.username || "زبونة";
  const subject = urgent ? `⚠️ ${who} بدها رد منك` : `💬 ${who} حكت معنا على انستغرام`;
  const chatHtml = conv.messages
    .map((m) => `<p style="margin:4px 0"><b>${m.who === "customer" ? esc(who) : "Hausofit"}:</b> ${esc(m.text).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;max-width:600px">
${urgent ? `<p style="background:#fff3cd;padding:10px;border-radius:6px"><b>المحادثة انتقلت إلك</b> ${esc(conv.handoffReason || "")}</p>` : ""}
<p>${esc(summary).replace(/\n/g, "<br>")}</p>
${conv.chatUrl ? `<p><a href="${esc(conv.chatUrl)}">افتح المحادثة بـ ManyChat</a></p>` : ""}
<hr style="border:none;border-top:1px solid #ddd">
<p style="color:#888;font-size:13px">المحادثة كاملة:</p>
${chatHtml}
</div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.SUMMARY_EMAIL_FROM || "Hausofit DM agent <onboarding@resend.dev>",
      to: [env.SUMMARY_EMAIL_TO],
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
