# Overturn for Intercom

QA for AI-drafted replies, in the Intercom inbox. A small Canvas Kit app watches the conversation for the AI draft, diffs it against what the teammate actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The drafting agent never has to be instrumented: Fin, another vendor's AI or a homegrown drafter all count, as long as the teammate confirms the draft in the panel.

## How it works on this surface

Intercom's Canvas Kit is a server-rendered surface: the app is a tiny hosted endpoint (`src/main.ts`) that Intercom calls when the panel opens (**initialize**) and when the teammate submits the form (**submit**). Every call is verified against the app's client secret (HMAC-SHA256 over the raw body, timing-safe compare) before anything is read or posted - an unsigned call gets a 401 and touches nothing.

- **No draft yet**: the canvas is a single line, "Waiting for a draft". A conversation with no draft in it is never read beyond that.
- **Draft**: if a drafting agent recorded its run with the Overturn SDK (`externalId: "ic:<conversation id>"`), the form opens prefilled with that draft. Otherwise the teammate pastes the draft (or leaves it for the recorded run). "What you sent" starts as a copy of the draft, so an unchanged send is one click.
- **Where did the draft come from?** The form asks, and starts at **Not sure**: `draft:ai` is tagged only when an assist produced the draft (or a recorded run supplied it - the SDK told us), `draft:manual` when the human typed it, and `draft:unknown` when nobody said. The tag is always present; guessing an origin we were not told is worse than `unknown`, so the app never guesses.
- **Reason**: one click from the support pack (wrong answer, should have escalated, tone / wording...). With `require_reason` on (the default), submitting a *changed* reply with no reason picked re-renders the form with an error and posts nothing. The Intercom send itself is never blocked by this app - the form is the enforceable moment on this surface, and Overturn failing never blocks the teammate's work.
- **Decision fields**: with `OVERTURN_DECISION_FIELDS` set (for example `refund_status:status`), the conversation attributes named there travel as the draft and sent `fields`, so a change in the decision itself is scored exactly. Without it, draft and sent carry text only.
- **The reply that actually went out**: the teammate does not have to re-type what they sent. Subscribe the app's webhook to `conversation.admin.replied` (and `conversation.admin.noted` when `OVERTURN_CAPTURE_INTERNAL_NOTES` is on) and Intercom delivers the sent reply to `/webhook`. The capture then uses the real sent text and the real sender. A changed reply with no reason is held in the panel until one is picked; the send itself already happened and is never held. A webhook delivery is verified by its `X-Hub-Signature` (HMAC-SHA1 of the raw body) and always answered 200, so a failed capture is held for the panel instead of retried into a storm. A redelivery of an event already captured is answered as a duplicate.
- **What the webhook cannot see**: the panel has to have seen the draft first - the teammate opened the panel, or a drafting agent recorded its run - because a conversation with no draft in it is never read or captured. Fin and bot replies arrive on `conversation.admin.replied` too, so only a reply authored by a human admin counts as the teammate's send.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build and deploy the server anywhere HTTPS: `pnpm --filter @overturn-ai/intercom-app build` → `dist/overturn-intercom-app.zip` (a node server plus `app/app-config.json`).
3. In Intercom: create an app, enable the Canvas Kit inbox location, and point **initialize** / **submit** at `https://<your host>/initialize` and `/submit`. To capture the reply that actually went out, add a webhook at `https://<your host>/webhook` subscribed to `conversation.admin.replied` (plus `conversation.admin.noted` when internal notes are captured).
4. Environment (see `app/app-config.json`):
   - `INTERCOM_CLIENT_SECRET`: the Intercom app's client secret (verifies `X-Body-Signature` on Canvas Kit calls and `X-Hub-Signature` on webhooks)
   - `OVERTURN_API_KEY`: the project API key (sent as the capture bearer token)
   - `OVERTURN_REASON_PACK` (default `support`), `OVERTURN_AGENT` (default `support-reply`), `OVERTURN_REQUIRE_REASON` (default on), `OVERTURN_CAPTURE_INTERNAL_NOTES` (default off), `OVERTURN_DECISION_FIELDS` (for example `refund_status:status`, default none), `OVERTURN_BASE_URL` (self-hosting)

## Replay what it captured

```bash
overturn cases list --agent support-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent support-reply
```

## Development

```bash
pnpm --filter @overturn-ai/intercom-app test      # payload builder, origin tags, canvas builders, signature + submit flow, webhook flow
pnpm --filter @overturn-ai/intercom-app build
```

`src/capture.ts` is the payload logic (pure, tested); `src/canvas.ts` builds the Canvas Kit JSON; `src/server.ts` is the signed initialize/submit/webhook handler; `src/main.ts` is the node HTTP bootstrap.
