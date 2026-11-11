# Hausofit - our own Instagram DM agent

```
Customer DMs @hausofit.official
   -> Meta sends a webhook to our server (api/webhook.py)
   -> server reads the last messages of the chat (memory)
   -> Claude answers, checking prices/stock LIVE on hausofit.co.il
   -> server sends the reply on Instagram
   -> unsure / order / complaint -> fixed "the team will reply" line, bot stays quiet 12h
```

Backup path (step 4): ManyChat calls `api/reply.py`, same brain.

## Files
- `hausofit/agent.py` - the brain: rules + tools (list_products, product_sizes, hand_off).
- `hausofit/store.py` - live products, prices, stock per size from the site's public Store API.
- `hausofit/instagram.py` - send DMs, chat history, Meta signature check.
- `api/webhook.py` - Instagram webhook (direct, no ManyChat).
- `api/reply.py` - ManyChat entry point (backup).
- `knowledge.md` - shipping, payment, returns, sizes. Prices are NOT here (they come live from the site).
- `privacy.html`, `data-deletion.html` - pages Meta asks for.

## Step 1 - Meta app (owner, in the browser, ~20 min)
1. developers.facebook.com -> My Apps -> Create App.
   Use case: "Manage messaging & content on Instagram". Business portfolio: Hausofit.
2. In the app: Instagram -> "API setup with Instagram login".
   - "Generate access tokens" -> add @hausofit.official -> copy the token  => `IG_ACCESS_TOKEN`
   - copy the account ID shown next to it => `IG_ACCOUNT_ID`
   - copy "Instagram app secret" => `IG_APP_SECRET`
3. App settings -> Basic: privacy policy URL = `https://<project>.vercel.app/privacy.html`,
   data deletion URL = `https://<project>.vercel.app/data-deletion.html`, category Shopping, an icon.
4. In the Instagram app on the phone: Settings -> Messages and story replies ->
   Message controls / Connected tools -> allow access to messages.

## Step 2 - put the server online (Vercel)
1. Vercel -> New Project -> Root Directory `instagram-agent`.
2. Environment variables (owner types them, never in chat):
   `ANTHROPIC_API_KEY`, `IG_ACCESS_TOKEN`, `IG_APP_SECRET`, `IG_ACCOUNT_ID`,
   `IG_VERIFY_TOKEN` (any long word), `BOT_ENABLED=1`,
   `ALLOWED_SENDER_IDS` = the test account's id (only it gets replies while testing).
3. Deploy.

## Step 3 - connect and test
1. Meta app -> Instagram -> Webhooks: callback `https://<project>.vercel.app/api/webhook`,
   verify token = `IG_VERIFY_TOKEN` -> Verify and save -> subscribe to `messages`.
2. From a second Instagram account (added as Instagram tester in the app), DM the shop.
   Check Vercel logs for "sent". Try: price, size stock, order status (should hand off), a photo.
3. Go live: remove `ALLOWED_SENDER_IDS`. If real customers' messages do not reach the
   webhook, request Advanced Access for `instagram_business_manage_messages`
   (App Review: screencast of the bot answering + business verification).

## Step 4 - ManyChat (only if we need replies before Meta is ready)
External Request POST `https://<project>.vercel.app/api/reply`, header `X-Hausofit-Key`
= `HAUSOFIT_SHARED_SECRET`, body `{"text":"{{last_text_input}}","name":"{{first_name}}"}`,
map `$.reply` -> field `ai_reply`, send `{{ai_reply}}`. Needs ManyChat Pro.
Limit: ManyChat waits 10s; slow stock checks fall back to the hand-off line.

## Safety switches
- `BOT_ENABLED` not "1" -> bot is silent. Turn off any time in Vercel.
- `ALLOWED_SENDER_IDS` -> replies only to listed people (testing).
- After a hand-off the bot stays quiet with that customer for 12h.
- Every request is checked with the Meta app secret signature.

## To do later
- The Instagram token lasts 60 days: add an automatic refresh (`refresh_access_token`).
- Order status by order number (needs a read-only WooCommerce API key).
- Comments ("سعر" under a post -> DM).
- Notify the owner on WhatsApp on hand-off.

## Open questions for the owner
1. Most common questions? 2. Anything the agent must never say?
3. Instagram is Business/Creator and linked to the "Hausofit" page?
