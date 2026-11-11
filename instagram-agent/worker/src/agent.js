// The Hausofit DM brain: Claude + live store data. Used by the Instagram
// webhook and by the ManyChat endpoint.

import Anthropic from "@anthropic-ai/sdk";
import KNOWLEDGE from "../../knowledge.md";
import { listProducts } from "./store.js";

// Fixed hand-off lines. The webhook looks for these in the chat history to
// know a human took over, so keep them exactly as they are.
export const HANDOFF_TEXT = {
  ar: "تمام، حدا من الفريق رح يرد عليكي هون بأقرب وقت 🤍",
  he: "בשמחה, מישהי מהצוות תחזור אלייך כאן בהקדם 🤍",
  en: "Got it, someone from our team will reply here soon 🤍",
};

const RULES = `You answer Instagram DMs for Hausofit, a women's activewear brand.
The customer is a woman. Write like a friendly person from the shop, not a bot.

Language: reply in the language and dialect the customer used. Arabic in Arabic
(local spoken dialect), Hebrew in Hebrew, English in English. Feminine forms.

Style: short, 1-3 sentences, like a real DM. At most one emoji. No all-caps.
Never use em dashes. Plain text only (Instagram shows no markdown).

Products, prices and stock: the CATALOG below is live from the site (Hebrew
names, refreshed every few minutes). Match what she means (leggings, bra, set,
shorts, jacket...) and the line names (FLOW, NOHUT, MIVNI, FORMA, OR SHINI).
sizes_colours lists every size/colour with "in stock", "1-2 left" or
"sold out". Never say a price, size or colour that is not in the CATALOG.
If a product has old_price_ils, you may say it is on sale. Give the product
link when she wants to buy. If what she asks is not clear from the CATALOG,
do not ask her whether to check with the team: call hand_off.

Policies (shipping, payment, returns, sizes): only from STORE FACTS.

Call hand_off when: order status/tracking/changes/refunds, complaints, she asks
for a person, wholesale/collabs/influencers, a photo or voice message you cannot
read, anything you cannot confirm, or you are not sure. After hand_off write
nothing else.

Never talk about competitors, politics, religion, other customers or anything
outside the shop. Never promise what the catalog or facts do not say.

STORE FACTS:
${KNOWLEDGE}`;

const TOOLS = [
  {
    name: "hand_off",
    description:
      "Pass the chat to a human from the team. The customer gets a fixed 'the team will reply soon' line in her language.",
    input_schema: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["ar", "he", "en"] },
        reason: { type: "string" },
      },
      required: ["language", "reason"],
      additionalProperties: false,
    },
    strict: true,
  },
];

// Language of a message from its letters, for the fixed hand-off lines.
export function guessLanguage(text) {
  const s = text || "";
  if (/[֐-׿]/.test(s)) return "he";
  if (/[؀-ۿ]/.test(s)) return "ar";
  if (/[A-Za-z]/.test(s)) return "en";
  return "ar";
}

export function handoff(language, reason) {
  return { reply: HANDOFF_TEXT[language] || HANDOFF_TEXT.ar, handoff: true, reason };
}

export function isHandoffText(text) {
  return Object.values(HANDOFF_TEXT).includes((text || "").trim());
}

// history: earlier messages, oldest first: [{ who: "customer" | "shop", text }]
export async function answer(env, text, history = [], name = "") {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 25_000, maxRetries: 1 });
  const catalog = await listProducts();
  const lang = guessLanguage(text);

  const lines = [];
  if (history.length) {
    lines.push("Earlier in this chat:");
    for (const m of history) lines.push(`${m.who === "customer" ? "Customer" : "Shop"}: ${m.text}`);
    lines.push("");
  }
  if (name) lines.push(`Customer name: ${name}`);
  lines.push(`New message from the customer: ${text}`);

  const response = await client.beta.messages.create({
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: 4096,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [
      { type: "text", text: RULES, cache_control: { type: "ephemeral" } },
      { type: "text", text: `CATALOG:\n${JSON.stringify(catalog)}`, cache_control: { type: "ephemeral" } },
    ],
    tools: TOOLS,
    messages: [{ role: "user", content: lines.join("\n") }],
  });

  if (response.stop_reason === "refusal") return handoff(lang, "refusal");
  const ho = response.content.find((b) => b.type === "tool_use" && b.name === "hand_off");
  if (ho) return handoff(ho.input.language || lang, ho.input.reason);

  const out = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return out ? { reply: out, handoff: false, reason: "" } : handoff(lang, "empty reply");
}
