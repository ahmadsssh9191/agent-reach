"""Instagram webhook: Meta calls this for every new DM to @hausofit.official.

GET  -> Meta's one-time check when the webhook is saved (hub.challenge).
POST -> new messages. We reply with the agent, unless a human took over.

Env vars (set in Vercel by the owner):
    ANTHROPIC_API_KEY   Claude API key
    IG_ACCESS_TOKEN     Instagram user access token (from the Meta app dashboard)
    IG_APP_SECRET       Instagram app secret (checks that requests come from Meta)
    IG_VERIFY_TOKEN     any string; the same one is typed in the Meta webhook form
    IG_ACCOUNT_ID       the Instagram account id of @hausofit.official
    BOT_ENABLED         "1" to reply. Anything else = the bot stays silent.
    ALLOWED_SENDER_IDS  optional, comma-separated. If set, the bot only replies to
                        these customers (for testing before going live).
"""

import json
import os
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from hausofit import agent, instagram  # noqa: E402

HUMAN_PAUSE_SECONDS = 12 * 3600  # bot stays quiet this long after a hand-off
_seen_mids: list = []  # best-effort guard against Meta re-sending the same message


def _allowed(sender_id: str) -> bool:
    if os.environ.get("BOT_ENABLED") != "1":
        return False
    allow = [s.strip() for s in os.environ.get("ALLOWED_SENDER_IDS", "").split(",") if s.strip()]
    return not allow or sender_id in allow


def handle_event(event: dict) -> str:
    """Process one messaging event. Returns a short status for the logs."""
    my_id = os.environ.get("IG_ACCOUNT_ID", "")
    message = event.get("message") or {}
    sender = str((event.get("sender") or {}).get("id", ""))

    if message.get("is_echo") or not sender or sender == my_id:
        return "skip: echo/own"
    mid = message.get("mid")
    if mid and mid in _seen_mids:
        return "skip: duplicate"
    if mid:
        _seen_mids.append(mid)
        del _seen_mids[:-200]
    if not _allowed(sender):
        return "skip: bot off or sender not allowed"

    text = (message.get("text") or "").strip()
    history = instagram.recent_history(sender, my_id)

    # A human took over recently: stay quiet.
    now = time.time()
    for m in history:
        if m["who"] == "shop" and agent.is_handoff_text(m["text"]) and now - m["at"] < HUMAN_PAUSE_SECONDS:
            return "skip: human handling"

    # Drop the current message from history if the API already returned it.
    if history and history[-1]["who"] == "customer" and history[-1]["text"] == text:
        history = history[:-1]

    if not text:
        # Photo, voice note, sticker or story reply without text.
        result = agent.handoff("ar", "no text (media)")
    else:
        try:
            result = agent.answer(text[:2000], history[-8:])
        except Exception as e:
            print(f"agent error: {e!r}")
            result = agent.handoff("ar", "agent error")

    instagram.send_text(sender, result["reply"])
    return f"sent (handoff={result['handoff']} {result.get('reason', '')})"


class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: str, ctype: str = "text/plain") -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        token = os.environ.get("IG_VERIFY_TOKEN")
        if q.get("hub.mode", [""])[0] == "subscribe" and token and q.get("hub.verify_token", [""])[0] == token:
            self._send(200, q.get("hub.challenge", [""])[0])
        else:
            self._send(403, "forbidden")

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if not instagram.verify_signature(raw, self.headers.get("X-Hub-Signature-256")):
            self._send(401, "bad signature")
            return
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send(400, "bad json")
            return
        for entry in payload.get("entry", []):
            for event in entry.get("messaging", []):
                try:
                    print(handle_event(event))
                except Exception as e:  # never make Meta retry because of our bug
                    print(f"event error: {e!r}")
        self._send(200, "ok")
