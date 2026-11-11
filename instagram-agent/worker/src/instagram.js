// Instagram API with Instagram Login: send DMs, read chat history, check webhook signatures.

const GRAPH = "https://graph.instagram.com/v27.0";

async function call(env, method, path, { params, body } = {}) {
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${env.IG_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`instagram ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export async function verifySignature(env, rawBody, header) {
  if (!env.IG_APP_SECRET || !header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.IG_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const expected = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// Instagram allows 1000 bytes per message; split long replies on spaces.
export async function sendText(env, recipientId, text) {
  const enc = new TextEncoder();
  const chunks = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (enc.encode(candidate).length > 950 && current) {
      chunks.push(current);
      current = word;
    } else current = candidate;
  }
  if (current) chunks.push(current);
  for (const chunk of chunks) {
    await call(env, "POST", "/me/messages", { body: { recipient: { id: recipientId }, message: { text: chunk } } });
  }
}

// Last messages with this customer, oldest first: [{ who, text, at }].
// Returns [] if the API does not answer; the agent then works without memory.
export async function recentHistory(env, customerId, limit = 10) {
  try {
    const conv = await call(env, "GET", "/me/conversations", {
      params: { platform: "instagram", user_id: customerId },
    });
    if (!conv.data?.length) return [];
    const msgs = await call(env, "GET", `/${conv.data[0].id}`, {
      params: { fields: `messages.limit(${limit}){message,from,created_time}` },
    });
    const out = [];
    for (const m of msgs.messages?.data || []) {
      const text = (m.message || "").trim();
      if (!text) continue;
      out.push({
        who: String(m.from?.id) === String(env.IG_ACCOUNT_ID) ? "shop" : "customer",
        text,
        at: Date.parse(m.created_time || "") || 0,
      });
    }
    return out.reverse();
  } catch (e) {
    console.log(`history error: ${e.message}`);
    return [];
  }
}
