# Overturn for Gorgias

QA for AI-drafted replies, in the Gorgias ticket sidebar. It watches the ticket for the AI draft, diffs it against what the agent actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. Ecommerce teams are this surface's first users, so the ticket's **order context rides on both answers as fields** (order number, total, currency, payment and fulfilment status): a change to the order between draft and send is scored exactly, like any other decision field.

## How it works on this surface

The app is a widget iframe in the ticket sidebar. Gorgias hands the widget the ticket id and the app settings as URL query parameters; the ticket, its messages and its order are then read through the **Gorgias REST API** (the documented surface for widgets). Two honest consequences of that surface, stated rather than papered over:

- **A widget cannot see the reply box.** A draft reaches the panel two ways: a drafting agent recorded its run with the Overturn SDK (`externalId: "gr:<ticket id>"`), and the panel finds it; or the agent pastes the draft into the panel and marks it ("Use this text as the draft"). Sends are observed as new agent messages on the ticket, polled every few seconds.
- **A widget cannot stop a send.** With `require_reason` on (the default), a changed send with no reason picked holds its capture in the panel ("Pick why you changed the reply - the capture is held until you do") and posts the moment the agent clicks a reason. The reply is never delayed; the correction is never posted reason-less.

What the agent sees:

- **Draft recorded by your agent · 64 words** (or "Draft marked by you"), plus the order line: number, total, status.
- A **reason** row of one-click chips from the support pack (wrong answer, missing information, should have escalated, tone / wording...) and an optional note.
- On **send**: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric.

Overturn failing never blocks the agent's work; the panel says what happened. With a `scope_tag` set, tickets without the tag are never read at all.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/gorgias-app build` → `dist/overturn-gorgias-app.zip`; host the unzipped folder anywhere HTTPS.
3. In Gorgias: Settings → Integrations → add an HTTP/widget integration pointing at the hosted `assets/iframe.html` in the ticket sidebar, passing the settings below (see `app/manifest.json` for the full parameter list).
4. Settings:
   - `overturn_api_key`: the project API key (sent as the capture bearer token)
   - `gorgias_account`: your account subdomain (`acme` for acme.gorgias.com)
   - `gorgias_api_token`: a Gorgias API token with ticket read access (bearer for the REST calls)
   - `reason_pack`: `support` (default on this surface) or `claims`
   - `agent`: the workflow name, one regression suite per workflow (default `support-reply`)
   - `require_reason` (default on), `capture_internal_notes`, `min_draft_chars`, `scope_tag`, `overturn_base_url` (self-hosting)

## Replay what it captured

```bash
overturn cases list --agent support-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent support-reply
```

## Development

```bash
pnpm --filter @overturn-ai/gorgias-app test      # payload builder, order fields, send observation, pending capture
pnpm --filter @overturn-ai/gorgias-app build
```

`src/capture.ts` is the logic (pure, tested); `src/main.ts` is the widget glue (REST reads, polling, panel); `app/` is the widget page and manifest. One shared change rides with this package: `"gorgias"` is added to `captureSourceSchema` in `packages/shared`, without which a gorgias capture body fails the shared contract.
