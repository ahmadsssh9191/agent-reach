"""Instagram API with Instagram Login: send DMs, read chat history, verify webhooks."""

import hashlib
import hmac
import json
import os
import time
import urllib.parse
import urllib.request

GRAPH = "https://graph.instagram.com/v27.0"


def _token() -> str:
    return os.environ["IG_ACCESS_TOKEN"]


def _request(method: str, path: str, params: dict | None = None, body: dict | None = None):
    params = dict(params or {})
    url = f"{GRAPH}{path}?{urllib.parse.urlencode(params)}" if params else f"{GRAPH}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {_token()}",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode("utf-8"))


def verify_signature(raw_body: bytes, header: str | None) -> bool:
    secret = os.environ.get("IG_APP_SECRET", "")
    if not secret or not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[len("sha256="):])


def send_text(recipient_id: str, text: str) -> None:
    # Instagram allows 1000 bytes per message; split long replies on spaces.
    chunks, current = [], ""
    for word in text.split(" "):
        candidate = f"{current} {word}".strip()
        if len(candidate.encode("utf-8")) > 950 and current:
            chunks.append(current)
            current = word
        else:
            current = candidate
    if current:
        chunks.append(current)
    for chunk in chunks:
        _request("POST", "/me/messages", body={"recipient": {"id": recipient_id}, "message": {"text": chunk}})


def recent_history(customer_id: str, my_id: str, limit: int = 10) -> list:
    """Last messages with this customer, oldest first: [{"who", "text", "at"}].
    Returns [] if the API does not answer; the agent then works without memory."""
    try:
        conv = _request("GET", "/me/conversations", {"platform": "instagram", "user_id": customer_id})
        if not conv.get("data"):
            return []
        conv_id = conv["data"][0]["id"]
        msgs = _request("GET", f"/{conv_id}", {"fields": f"messages.limit({limit}){{message,from,created_time}}"})
    except Exception as e:
        print(f"history error: {e!r}")
        return []
    out = []
    for m in (msgs.get("messages") or {}).get("data", []):
        text = (m.get("message") or "").strip()
        if not text:
            continue
        who = "shop" if str((m.get("from") or {}).get("id")) == str(my_id) else "customer"
        out.append({"who": who, "text": text, "at": _parse_time(m.get("created_time"))})
    out.reverse()
    return out


def _parse_time(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        return time.mktime(time.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except ValueError:
        return 0.0
