"""ManyChat entry point (backup path, step 4 of the plan). Same brain as the webhook.

ManyChat "External Request" sends POST /api/reply with JSON:
    {"text": "<customer message>", "name": "<first name>", "user_id": "<contact id>"}
and header  X-Hausofit-Key: <HAUSOFIT_SHARED_SECRET>.
We answer {"reply": "...", "handoff": true|false}.

Note: ManyChat waits at most 10 seconds. Questions that need a stock check
can take longer; those get the hand-off line instead of a timeout.
"""

import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from hausofit import agent  # noqa: E402

_pool = ThreadPoolExecutor(max_workers=4)


class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"ok": True})

    def do_POST(self):
        secret = os.environ.get("HAUSOFIT_SHARED_SECRET")
        if not secret or self.headers.get("X-Hausofit-Key") != secret:
            self._send(401, {"error": "unauthorized"})
            return
        try:
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._send(400, {"error": "bad json"})
            return

        text = str(payload.get("text") or "").strip()[:2000]
        if not text:
            self._send(200, agent.handoff("ar", "no text"))
            return
        future = _pool.submit(agent.answer, text, None, str(payload.get("name") or "")[:60])
        try:
            result = future.result(timeout=8.5)
        except FutureTimeout:
            result = agent.handoff("ar", "too slow for ManyChat")
        except Exception as e:
            print(f"agent error: {e!r}")
            result = agent.handoff("ar", "agent error")
        self._send(200, result)
