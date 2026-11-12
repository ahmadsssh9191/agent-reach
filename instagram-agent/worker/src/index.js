// Hausofit DM agent on Cloudflare Workers.
//   GET  /webhook         Meta's one-time webhook check
//   POST /webhook         new Instagram DMs (direct Instagram API)
//   POST /reply           ManyChat External Request (backup path)
//   GET  /privacy.html, /data-deletion.html   pages Meta asks for
//   GET  /                health check

import PRIVACY from "../../privacy.html";
import DATA_DELETION from "../../data-deletion.html";
import { answer, guessLanguage, handoff, isHandoffText, updateProfile } from "./agent.js";
import { recentHistory, sendText, verifySignature } from "./instagram.js";
import * as mc from "./manychat.js";
import { flushQuiet, sendSummary, trackMessage } from "./summary.js";

const HUMAN_PAUSE_MS = 12 * 3600 * 1000; // bot stays quiet this long after a hand-off
const seenMids = new Set(); // best effort: Meta sometimes sends the same message twice

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const html = (body) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });

function allowed(env, senderId) {
  if (env.BOT_ENABLED !== "1") return false;
  const list = (env.ALLOWED_SENDER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return !list.length || list.includes(senderId);
}

export async function handleEvent(env, event) {
  const message = event.message || {};
  const sender = String(event.sender?.id || "");
  if (message.is_echo || !sender || sender === String(env.IG_ACCOUNT_ID)) return "skip: echo/own";
  if (message.mid) {
    if (seenMids.has(message.mid)) return "skip: duplicate";
    seenMids.add(message.mid);
    if (seenMids.size > 500) seenMids.delete(seenMids.values().next().value);
  }
  if (!allowed(env, sender)) return "skip: bot off or sender not allowed";

  const text = (message.text || "").trim();
  let history = await recentHistory(env, sender);

  const now = Date.now();
  if (history.some((m) => m.who === "shop" && isHandoffText(m.text) && now - m.at < HUMAN_PAUSE_MS)) {
    return "skip: human handling";
  }
  // The API may already include the current message; don't send it twice.
  const last = history[history.length - 1];
  if (last && last.who === "customer" && last.text === text) history = history.slice(0, -1);

  let result;
  if (!text) {
    const lastText = [...history].reverse().find((m) => m.who === "customer")?.text;
    result = handoff(guessLanguage(lastText || "ع"), "no text (photo, voice, sticker)");
  } else {
    try {
      result = await answer(env, text.slice(0, 2000), history.slice(-8));
    } catch (e) {
      console.log(`agent error: ${e.message}`);
      result = handoff(guessLanguage(text), "agent error");
    }
  }
  if (result.silent) return `silent (${result.reason || ""})`;
  await sendText(env, sender, result.reply);
  return `sent (handoff=${result.handoff} ${result.reason || ""})`;
}

async function webhookPost(request, env, ctx) {
  const raw = await request.arrayBuffer();
  if (!(await verifySignature(env, raw, request.headers.get("X-Hub-Signature-256")))) {
    return new Response("bad signature", { status: 401 });
  }
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("bad json", { status: 400 });
  }
  // Answer Meta at once; do the slow work (Claude, store, sending) after.
  const work = (async () => {
    for (const entry of payload.entry || []) {
      for (const event of entry.messaging || []) {
        try {
          console.log(await handleEvent(env, event));
        } catch (e) {
          console.log(`event error: ${e.message}`);
        }
      }
    }
  })();
  ctx.waitUntil(work);
  return new Response("ok");
}

async function replyLater(env, id, text, name) {
  try {
    const sub = await mc.getSubscriber(env, id);
    if (mc.humanHandling(sub)) return console.log("manychat async: skip, human handling");
    if ((sub.tags || []).some((t) => /^no ?bot$/i.test(String(t.name || "").trim()))) {
      return console.log("manychat async: skip, contact tagged no bot");
    }
    const history = mc.readHistory(sub);
    const profile = mc.readProfile(sub);
    let result;
    if (!text) {
      result = handoff("ar", "no text (photo, voice, sticker)");
    } else {
      try {
        result = await answer(env, text, history, name, { effort: env.CLAUDE_EFFORT_ASYNC || "medium", profile });
      } catch (e) {
        console.log(`agent error: ${e.message}`);
        result = handoff(guessLanguage(text), "agent error");
      }
    }
    const track = (extra) =>
      trackMessage(env, id, {
        text: text || "(photo / voice / sticker)",
        name: name || sub.name,
        username: sub.ig_username,
        chatUrl: sub.live_chat_url,
        ...extra,
      }).catch((e) => console.log(`track: ${e.message}`));
    if (result.silent) {
      await track({ silent: true });
      return console.log(`manychat async: silent (${result.reason})`);
    }
    try {
      await mc.sendText(env, id, result.reply, result.images || []);
    } catch (e) {
      // A photo Instagram refuses should not block the text.
      if (!result.images?.length) throw e;
      console.log(`send with photo failed, retrying text only: ${e.message}`);
      await mc.sendText(env, id, result.reply);
    }
    await track({ reply: result.reply, handoff: result.handoff, reason: result.reason });
    if (text) {
      await mc.saveHistory(env, id, history, text, result.reply).catch((e) => console.log(`history save: ${e.message}`));
      await updateProfile(env, profile, name || sub.name, history, text, result.reply)
        .then((p) => p && mc.saveProfile(env, id, p))
        .catch((e) => console.log(`profile save: ${e.message}`));
    }
    if (result.handoff) await mc.markHandoff(env, id, HUMAN_PAUSE_MS / 3600000);
    console.log(`manychat async: sent (handoff=${result.handoff} ${result.reason || ""})`);
  } catch (e) {
    console.log(`manychat async error: ${e.message}`);
  }
}

async function manychat(request, env, ctx) {
  if (!env.HAUSOFIT_SHARED_SECRET || request.headers.get("X-Hausofit-Key") !== env.HAUSOFIT_SHARED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  let text = String(payload.text || "").trim().slice(0, 2000);
  // An unfilled ManyChat variable (e.g. "{{last_input_text}}") means we got no real text.
  if (/^\{\{.*\}\}$/.test(text)) text = "";
  // Conversation-starter buttons arrive as their label text.
  const BUTTONS = [
    [/مساعدة بالمقاس|עזרה במידה/, "زر: مساعدة بالمقاس"],
    [/شو الجديد|מה חדש/, "زر: شو الجديد"],
    [/التوصيل والدفع|משלוח ותשלום/, "زر: التوصيل والدفع"],
    [/بدي أحكي مع حدا|לדבר עם נציגה/, "زر: بدي أحكي مع حدا"],
  ];
  if (text.includes("·")) {
    const hit = BUTTONS.find(([re]) => re.test(text));
    if (hit) text = hit[1];
  }

  const subscriberId = String(payload.user_id || "").replace(/[^0-9]/g, "");
  console.log(`manychat: ${text.length} chars, subscriber ${subscriberId ? "yes" : "no"}`);

  // Test email (same secret): sends a summary of a sample conversation.
  if (payload.test_email === true) {
    const conv = {
      name: "مايا (تجربة)",
      chatUrl: "https://app.manychat.com/",
      messages: [
        { who: "customer", text: "قديش التايتس الزهري؟" },
        { who: "shop", text: "أهلاً فيكي 🤍 التايتس الزهري بـ149 شيكل، متوفر من XS لـL. أي مقاس بتلبسي عادة؟" },
        { who: "customer", text: "M، ابعتيلي رابط" },
        { who: "shop", text: "أكيد 🤍 https://hausofit.co.il/?p=6292" },
      ],
    };
    try {
      await sendSummary(env, conv, false);
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // Test mode (same secret): full thinking, optional history, no time limit.
  if (payload.test === true) {
    const history = Array.isArray(payload.history) ? payload.history.slice(-10) : [];
    const result = await answer(env, text, history, "", { effort: env.CLAUDE_EFFORT_ASYNC || "medium" });
    return json(result);
  }

  // Async path: answer ManyChat at once, think as long as needed, then send the
  // reply ourselves through the ManyChat API. No 10-second limit, real silence.
  if (subscriberId && env.MANYCHAT_API_KEY) {
    ctx.waitUntil(replyLater(env, subscriberId, text, String(payload.name || "").slice(0, 60)));
    return json({ reply: "", handoff: false, async: true });
  }

  if (!text) return json(handoff("ar", "no text"));
  const lang = guessLanguage(text);
  // ManyChat waits at most 10 seconds.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(handoff(lang, "too slow for ManyChat")), 8500));
  const work = answer(env, text, [], String(payload.name || "").slice(0, 60)).catch((e) => {
    console.log(`agent error: ${e.message}`);
    return handoff(lang, "agent error");
  });
  const result = await Promise.race([work, timeout]);
  // Until the ManyChat flow skips empty replies, never return an empty one there:
  // an empty field could make ManyChat resend the previous reply.
  if (result.silent && env.MANYCHAT_ALLOW_SILENT !== "1") {
    const steer = {
      ar: "أهلاً فيكي 🤍 أنا هون لأساعدك بكل إشي بخص قطعنا وطلبيتك، شو بتدوري عليه؟",
      he: "היי 🤍 אני כאן לעזור בכל מה שקשור לפריטים ולהזמנה שלך, מה את מחפשת?",
      en: "Hi 🤍 I'm here to help with anything about our pieces and your order, what are you looking for?",
    };
    return json({ reply: steer[lang] || steer.ar, handoff: false, reason: `steer: ${result.reason || ""}` });
  }
  return json(result);
}

export default {
  // Every 10 minutes: email summaries of conversations that went quiet.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(flushQuiet(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/webhook" && request.method === "GET") {
      const ok =
        url.searchParams.get("hub.mode") === "subscribe" &&
        env.IG_VERIFY_TOKEN &&
        url.searchParams.get("hub.verify_token") === env.IG_VERIFY_TOKEN;
      return ok ? new Response(url.searchParams.get("hub.challenge") || "") : new Response("forbidden", { status: 403 });
    }
    if (path === "/webhook" && request.method === "POST") return webhookPost(request, env, ctx);
    if (path === "/reply" && request.method === "POST") return manychat(request, env, ctx);
    if (path === "/privacy.html") return html(PRIVACY);
    if (path === "/data-deletion.html") return html(DATA_DELETION);
    if (path === "/") return json({ ok: true });
    return new Response("not found", { status: 404 });
  },
};
