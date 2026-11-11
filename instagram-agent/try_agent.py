"""Live test: real Claude + live site, nothing is sent to Instagram.

Put your key in instagram-agent/.env.local as one line:
    ANTHROPIC_API_KEY=sk-ant-...
(.env.local is git-ignored.) Then run:  python try_agent.py
"""

import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
here = os.path.dirname(os.path.abspath(__file__))
env_file = os.path.join(here, ".env.local")
if os.path.exists(env_file):
    for line in open(env_file, encoding="utf-8"):
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.strip().split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))
if not os.environ.get("ANTHROPIC_API_KEY"):
    sys.exit("No ANTHROPIC_API_KEY: add it to instagram-agent/.env.local")

sys.path.insert(0, here)
from hausofit import agent  # noqa: E402

QUESTIONS = [
    "مرحبا قديش سعر الليجنز؟",
    "في بنطلون FLOW مقاس M؟",
    "כמה עולה המשלוח?",
    "وين طلبيتي؟ صرلي اسبوع مستنية",
    "Do you have a sports bra in size L?",
    "شو رأيك بماركة تانية أرخص منكم؟",
]

for q in QUESTIONS:
    t = time.time()
    try:
        r = agent.answer(q)
        print(f"\nQ: {q}\nA: {r['reply']}\n   handoff={r['handoff']} {r['reason']}  ({time.time() - t:.1f}s)")
    except Exception as e:
        print(f"\nQ: {q}\nERROR: {e!r}")
