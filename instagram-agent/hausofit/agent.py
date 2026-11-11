"""The Hausofit DM brain: Claude + live store tools. Used by both entry points
(api/webhook.py for Instagram directly, api/reply.py for ManyChat)."""

import json
import os

import anthropic

from . import store

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
client = anthropic.Anthropic(timeout=20.0, max_retries=1)

_here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(_here, "..", "knowledge.md"), encoding="utf-8") as f:
    KNOWLEDGE = f.read()

# Fixed hand-off lines. The webhook looks for these in the chat history to
# know a human has taken over, so keep them exactly as they are.
HANDOFF_TEXT = {
    "ar": "تمام، حدا من الفريق رح يرد عليكي هون بأقرب وقت 🤍",
    "he": "בשמחה, מישהי מהצוות תחזור אלייך כאן בהקדם 🤍",
    "en": "Got it, someone from our team will reply here soon 🤍",
}

RULES = f"""You answer Instagram DMs for Hausofit, a women's activewear brand.
The customer is a woman. Write like a friendly person from the shop, not a bot.

Language: reply in the language and dialect the customer used. Arabic in Arabic
(local spoken dialect), Hebrew in Hebrew, English in English. Feminine forms.

Style: short, 1-3 sentences, like a real DM. At most one emoji. No all-caps.
Never use em dashes. Plain text only (Instagram shows no markdown).

Prices, products and stock: ALWAYS check with the tools before saying a price,
a product, a colour or whether a size is available. Product names on the site
are in Hebrew; match what she means (leggings, bra, set, shorts, jacket...) and
the line names (FLOW, NOHUT, MIVNI, FORMA, OR SHINI). If a product has an old
price, you may say it is on sale. Give the product link when she wants to buy.
If a tool fails, do not guess: hand off.

Policies (shipping, payment, returns, sizes): only from the facts below.

Call hand_off when: order status/tracking/changes/refunds, complaints, she
asks for a person, wholesale/collabs/influencers, a photo or voice message you
cannot read, or you are not sure. After hand_off write nothing else.

Never talk about competitors, politics, religion, other customers or anything
outside the shop. Never promise what the tools or facts do not say.

STORE FACTS:
{KNOWLEDGE}"""

TOOLS = [
    {
        "name": "list_products",
        "description": "All products on hausofit.co.il right now: id, Hebrew name, current price in ILS, old price if on sale, in-stock flag, size/colour options, link.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
        "strict": True,
    },
    {
        "name": "product_sizes",
        "description": "Live stock of every size/colour of one product (use the id from list_products). few_left means 1-2 pieces.",
        "input_schema": {
            "type": "object",
            "properties": {"product_id": {"type": "integer"}},
            "required": ["product_id"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "name": "hand_off",
        "description": "Pass the chat to a human from the team. The customer gets a fixed 'the team will reply soon' line in her language.",
        "input_schema": {
            "type": "object",
            "properties": {
                "language": {"type": "string", "enum": ["ar", "he", "en"]},
                "reason": {"type": "string"},
            },
            "required": ["language", "reason"],
            "additionalProperties": False,
        },
        "strict": True,
    },
]


def _run_tool(name: str, args: dict) -> str:
    if name == "list_products":
        return json.dumps(store.list_products(), ensure_ascii=False)
    if name == "product_sizes":
        return json.dumps(store.product_sizes(args["product_id"]), ensure_ascii=False)
    raise ValueError(f"unknown tool {name}")


def answer(text: str, history: list | None = None, name: str = "") -> dict:
    """Returns {"reply": str, "handoff": bool, "reason": str}.

    history: earlier messages, oldest first, as [{"who": "customer"|"shop", "text": ...}].
    """
    lines = []
    if history:
        lines.append("Earlier in this chat:")
        lines += [f"{'Customer' if m['who'] == 'customer' else 'Shop'}: {m['text']}" for m in history]
        lines.append("")
    if name:
        lines.append(f"Customer name: {name}")
    lines.append(f"New message from the customer: {text}")
    messages = [{"role": "user", "content": "\n".join(lines)}]

    for _ in range(5):
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=4096,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=[{"type": "text", "text": RULES, "cache_control": {"type": "ephemeral"}}],
            tools=TOOLS,
            messages=messages,
        )
        if response.stop_reason == "refusal":
            return handoff("ar", "refusal")

        tool_uses = [b for b in response.content if b.type == "tool_use"]
        for b in tool_uses:
            if b.name == "hand_off":
                return handoff(b.input.get("language", "ar"), b.input.get("reason", ""))

        if response.stop_reason != "tool_use" or not tool_uses:
            out = "".join(b.text for b in response.content if b.type == "text").strip()
            return {"reply": out, "handoff": False, "reason": ""} if out else handoff("ar", "empty reply")

        messages.append({"role": "assistant", "content": response.content})
        results = []
        for b in tool_uses:
            try:
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": _run_tool(b.name, b.input)})
            except Exception as e:
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": f"error: {e}", "is_error": True})
        messages.append({"role": "user", "content": results})

    return handoff("ar", "too many steps")


def handoff(language: str, reason: str) -> dict:
    return {"reply": HANDOFF_TEXT.get(language, HANDOFF_TEXT["ar"]), "handoff": True, "reason": reason}


def is_handoff_text(text: str) -> bool:
    return (text or "").strip() in HANDOFF_TEXT.values()
