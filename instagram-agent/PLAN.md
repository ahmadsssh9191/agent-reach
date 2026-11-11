# Hausofit - our own Instagram DM agent (Cloudflare Workers, free)

```
Customer DMs @hausofit.official
   -> Meta webhook (or ManyChat) calls our Worker on Cloudflare
   -> Worker reads the chat history (direct path only)
   -> Claude answers from the LIVE catalog: prices + stock per size/colour
   -> reply is sent; unsure / order / complaint -> fixed "team will reply" line,
      bot stays quiet with that customer for 12h
```

Monthly cost: Cloudflare $0 (free plan, commercial use allowed) + Claude covered by
the $100 monthly API credit + ManyChat Pro (~$15) only until Meta access works.

## Files
- `worker/src/agent.js` - the brain: rules, live catalog in context, hand_off tool.
- `worker/src/store.js` - products, prices and stock per size from hausofit.co.il (cached 5 min).
- `worker/src/instagram.js` - send DMs, chat history, Meta signature check.
- `worker/src/index.js` - routes: `/webhook` (Instagram direct), `/reply` (ManyChat),
  `/privacy.html`, `/data-deletion.html`, `/` (health).
- `worker/wrangler.toml` - Cloudflare settings and switches (`BOT_ENABLED`, `ALLOWED_SENDER_IDS`).
- `worker/try.mjs` - sends 6 test questions to the agent and prints the answers.
- `knowledge.md` - shipping, payment, returns, sizes. Prices/stock are NOT here (live from the site).

## Step A - put it online (today)
1. Owner: free account on cloudflare.com.
2. `cd instagram-agent/worker`, `npx wrangler login` (owner clicks Allow in the browser).
3. Secrets (never in chat or in files in git):
   `npx wrangler secret put ANTHROPIC_API_KEY`
   `npx wrangler secret put HAUSOFIT_SHARED_SECRET`  (any long random string, for ManyChat)
4. `npx wrangler deploy` -> address like `https://hausofit-dm-agent.<name>.workers.dev`.
5. Check: `node try.mjs https://.../reply` with the same shared secret.

## Step B - ManyChat (until Meta access works)
ManyChat Pro -> Default Reply (Instagram) flow:
- External Request POST `https://.../reply`, header `X-Hausofit-Key` = shared secret,
  body `{"text": "{{last_text_input}}", "name": "{{first_name}}"}`
- Map `$.reply` -> field `ai_reply`, `$.handoff` -> field `ai_handoff`
- Send `{{ai_reply}}`; if `ai_handoff` is true: tag "needs human", notify the owner,
  pause automation for this contact 24h.
Limit: ManyChat waits 10s; the Worker answers in 2-6s (first message after a pause ~9s).
If it takes over 8.5s the customer gets the hand-off line in her language.

## Step C - direct Instagram (after Meta developer registration)
Meta paused us on Nov 12 (too many SMS attempts). Wait 24-48h, then once:
add the owner's personal number in the Facebook app (Accounts Center -> Contact info,
Facebook only), then register at developers.facebook.com/async/registration.
1. Create app -> "Manage messaging & content on Instagram" -> Instagram API with Instagram login.
2. Generate token for @hausofit.official -> secrets `IG_ACCESS_TOKEN`, `IG_ACCOUNT_ID`;
   app secret -> `IG_APP_SECRET`; any word -> `IG_VERIFY_TOKEN`.
3. App settings: privacy `https://.../privacy.html`, deletion `https://.../data-deletion.html`.
4. Webhooks: callback `https://.../webhook`, verify token, subscribe `messages`.
5. Test with `ALLOWED_SENDER_IDS` = test account only, then empty it to go live, cancel ManyChat.

## Safety switches (Cloudflare dashboard -> Worker -> Settings -> Variables)
- `BOT_ENABLED` not "1" -> silent.  `ALLOWED_SENDER_IDS` -> only these people (testing).
- 12h quiet after a hand-off. Every Meta request checked with the app secret.

## Later
- Instagram token refresh every 60 days. Order status by order number (read-only Woo key).
- Comments -> DM. WhatsApp on the same brain (same Meta app). WhatsApp alert on hand-off.
