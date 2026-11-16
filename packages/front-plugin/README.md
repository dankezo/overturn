# Overturn for Front

QA for AI-drafted replies, in the Front sidebar. It watches the composer for the AI draft, diffs it against what the teammate actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The drafting agent never has to be instrumented: Front's own AI, a homegrown drafter or a macro all count, as long as the text lands in the reply box.

## What the teammate sees

A small panel in the conversation sidebar:

- **Draft inserted · 112 words** once an AI assist, macro or paste lands in the reply box (anything reply-sized inserted in one go). If the drafting agent recorded its run with the Overturn SDK (`externalId: "fr:<conversation id>"`), the draft is taken from that run instead. "Use the current text as the draft" marks it by hand.
- A **reason** box with quick picks from the claims pack (wrong coverage decision, wrong amount or date, missing required step, tone / wording, policy exception...). A support team can switch to the vendor-neutral support pack with the `reason_pack` setting.
- On **send**: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric.

Overturn failing never blocks the teammate's work; the panel says what happened.

### One honest limitation: `require_reason` in Front

In Zendesk, the app blocks a changed Submit until a reason is picked, because ZAF lets an app reject the save. Front's plugin SDK has no pre-send hook - it exposes the conversation and the composer draft, not the send button - so this plugin cannot stop a send, and does not pretend to. What `require_reason` does here: when a changed reply goes out with no reason picked, the capture is **held** in the panel ("Pick why you changed the reply - the capture is held until you do") and posts the moment the teammate clicks a reason. The reply is never delayed; the correction is never posted reason-less. (The same question was raised on the bounty issue; this is the strongest enforcement the documented SDK surface allows.)

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip`; host the unzipped folder anywhere HTTPS.
3. In Front: Settings → Plugins → add a plugin pointing at the hosted `index.html`, with the features the panel needs (sidebar + composer draft access), and pass the settings below as the plugin's configuration / query parameters.
4. Settings:
   - `overturn_api_key`: the project API key (sent as the capture bearer token)
   - `reason_pack`: `claims` (default on this surface) or `support`, the one-click reasons teammates see
   - `agent`: the workflow name, one regression suite per workflow (default `support-reply`)
   - `decision_fields`: conversation custom fields that *are* the decision, as `name:label` pairs, e.g. `status:status, total:total`. Changes to these are scored exactly; the prose is scored by the judge.
   - `require_reason` (default on), `capture_internal_notes`, `min_draft_chars`, `scope_tag` (only conversations carrying this tag are watched; every other conversation is never read), `overturn_base_url` (self-hosting)

## Replay what it captured

```bash
overturn cases list --agent claims-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent claims-reply
```

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test      # draft detection, diff, send decision, pending capture
pnpm --filter @overturn-ai/front-plugin build
```

`src/capture.ts` is the logic (pure, tested); `src/main.ts` is the Front SDK glue; `app/` is the plugin page.
