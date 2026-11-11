// Sends test questions to the agent's /reply endpoint and prints the answers.
// Usage: npm run dev   (in another terminal), then:  npm run try [url]
// The key must match HAUSOFIT_SHARED_SECRET in .dev.vars.

const url = process.argv[2] || "http://localhost:8787/reply";
const key = process.env.HAUSOFIT_SHARED_SECRET || "localtest";

const QUESTIONS = [
  "مرحبا قديش سعر الليجنز؟",
  "في بنطلون FLOW مقاس M؟",
  "כמה עולה המשלוח?",
  "وين طلبيتي؟ صرلي اسبوع مستنية",
  "Do you have a sports bra in size L?",
  "شو رأيك بماركة تانية أرخص منكم؟",
];

for (const text of QUESTIONS) {
  const t = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hausofit-Key": key },
    body: JSON.stringify({ text }),
  });
  const d = await res.json();
  console.log(`\nQ: ${text}\nA: ${d.reply}\n   handoff=${d.handoff} ${d.reason || ""} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}
