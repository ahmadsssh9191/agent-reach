// Plays whole conversations against the live agent in test mode (with memory),
// the way ManyChat now works. Nothing is sent to Instagram.
// Usage: node chat.mjs [url]   (HAUSOFIT_SHARED_SECRET must be set)

const url = process.argv[2] || "https://hausofit-dm-agent.hausofit-dm-agent.workers.dev/reply";
const key = process.env.HAUSOFIT_SHARED_SECRET;

const CHATS = [
  [
    "بدي توب MIVNI الاسود مقاس M",
    "وبدي كمان التايتس الاسود MIVNI مقاس M",
    "تمام بدي كلشي، قديش المجموع؟",
    "منثبت",
  ],
  ["بدي طقم FLOW البني، البنطلون L والطوب S، وزوج كلسات سود", "ثبتي"],
];

for (const chat of CHATS) {
  console.log("\n==================");
  const history = [];
  for (const text of chat) {
    const t = Date.now();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hausofit-Key": key },
      body: JSON.stringify({ text, history, test: true }),
    });
    const d = await res.json();
    const photos = (d.images || []).map((u) => `[photo: ${u.split("/").pop()}]\n`).join("");
    const reply = d.silent ? "(no reply)" : photos + d.reply;
    console.log(`\nزبونة: ${text}\nالايجينت: ${reply}\n   (${((Date.now() - t) / 1000).toFixed(1)}s${d.handoff ? `, handoff: ${d.reason}` : ""})`);
    history.push({ who: "customer", text });
    if (!d.silent) history.push({ who: "shop", text: reply });
  }
}
