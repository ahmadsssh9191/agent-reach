// Hausofit DM agent on Cloudflare Workers.
//   GET  /webhook         Meta's one-time webhook check
//   POST /webhook         new Instagram DMs (direct Instagram API)
//   POST /reply           ManyChat External Request (backup path)
//   GET  /privacy.html, /data-deletion.html   pages Meta asks for
//   GET  /                health check

import PRIVACY from "../../privacy.html";
import DATA_DELETION from "../../data-deletion.html";
import { answer, guessLanguage, handoff, isHandoffText } from "./agent.js";
import { recentHistory, sendText, verifySignature } from "./instagram.js";

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

async function manychat(request, env) {
  if (!env.HAUSOFIT_SHARED_SECRET || request.headers.get("X-Hausofit-Key") !== env.HAUSOFIT_SHARED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const text = String(payload.text || "").trim().slice(0, 2000);
  if (!text) return json(handoff("ar", "no text"));
  const lang = guessLanguage(text);
  // ManyChat waits at most 10 seconds.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(handoff(lang, "too slow for ManyChat")), 8500));
  const work = answer(env, text, [], String(payload.name || "").slice(0, 60)).catch((e) => {
    console.log(`agent error: ${e.message}`);
    return handoff(lang, "agent error");
  });
  return json(await Promise.race([work, timeout]));
}

export default {
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
    if (path === "/reply" && request.method === "POST") return manychat(request, env);
    if (path === "/privacy.html") return html(PRIVACY);
    if (path === "/data-deletion.html") return html(DATA_DELETION);
    if (path === "/") return json({ ok: true });
    return new Response("not found", { status: 404 });
  },
};
