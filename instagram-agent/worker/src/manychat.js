// ManyChat public API: lets the agent reply on its own time instead of
// inside ManyChat's 10-second External Request window.

const API = "https://api.manychat.com";
export const HANDOFF_FIELD = "ai_handoff_until"; // Number field: unix seconds
export const HANDOFF_TAG = "needs human";
export const HISTORY_FIELD = "ai_history"; // Text field: JSON of recent messages
export const PROFILE_FIELD = "ai_profile"; // Text field: what we know about her
const HISTORY_KEEP = 16;
const HISTORY_MAX_AGE_S = 7 * 24 * 3600;

export function readProfile(sub) {
  const f = (sub.custom_fields || []).find((x) => x.name === PROFILE_FIELD);
  return (f?.value || "").toString().slice(0, 1500);
}

export async function saveProfile(env, id, profile) {
  await call(env, "POST", "/fb/subscriber/setCustomFieldByName", {
    subscriber_id: id,
    field_name: PROFILE_FIELD,
    field_value: profile.slice(0, 1500),
  });
}

// Recent chat for this customer, oldest first: [{ who, text }].
export function readHistory(sub) {
  const f = (sub.custom_fields || []).find((x) => x.name === HISTORY_FIELD);
  try {
    const items = JSON.parse(f?.value || "[]");
    const now = Date.now() / 1000;
    return items.filter((m) => now - (m.t || 0) < HISTORY_MAX_AGE_S).map(({ w, x, t }) => ({ who: w, text: x, t }));
  } catch {
    return [];
  }
}

export async function saveHistory(env, id, history, customerText, shopText) {
  const t = Math.floor(Date.now() / 1000);
  const items = history.map((m) => ({ w: m.who, x: m.text, t: m.t || t }));
  items.push({ w: "customer", x: customerText, t });
  if (shopText) items.push({ w: "shop", x: shopText, t });
  let value = JSON.stringify(items.slice(-HISTORY_KEEP));
  // ManyChat text fields are limited; drop the oldest messages until it fits.
  let kept = items.slice(-HISTORY_KEEP);
  while (value.length > 3500 && kept.length > 2) {
    kept = kept.slice(2);
    value = JSON.stringify(kept);
  }
  await call(env, "POST", "/fb/subscriber/setCustomFieldByName", {
    subscriber_id: id,
    field_name: HISTORY_FIELD,
    field_value: value,
  });
}

async function call(env, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${env.MANYCHAT_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === "error") {
    throw new Error(`manychat ${res.status} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

export async function getSubscriber(env, id) {
  const r = await call(env, "GET", `/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(id)}`);
  return r.data || {};
}

// True while a human is handling this customer.
export function humanHandling(sub) {
  const f = (sub.custom_fields || []).find((x) => x.name === HANDOFF_FIELD);
  const until = Number(f?.value || 0);
  return until > Date.now() / 1000;
}

export async function sendText(env, id, text, images = [], channel = "instagram") {
  const lines = text.split("\n");
  // Instagram allows about 1000 characters per message; split long replies by lines.
  const messages = images.map((url) => ({ type: "image", url }));
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 900 && current) {
      messages.push({ type: "text", text: current });
      current = line;
    } else current = next;
  }
  if (current) messages.push({ type: "text", text: current });
  await call(env, "POST", "/fb/sending/sendContent", {
    subscriber_id: id,
    data: { version: "v2", content: { type: channel === "whatsapp" ? "whatsapp" : "instagram", messages } },
  });
}

export async function markHandoff(env, id, hours) {
  const until = Math.floor(Date.now() / 1000) + hours * 3600;
  await Promise.all([
    call(env, "POST", "/fb/subscriber/addTagByName", { subscriber_id: id, tag_name: HANDOFF_TAG }),
    call(env, "POST", "/fb/subscriber/setCustomFieldByName", {
      subscriber_id: id,
      field_name: HANDOFF_FIELD,
      field_value: until,
    }),
  ]);
}
