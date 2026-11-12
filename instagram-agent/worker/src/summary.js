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
