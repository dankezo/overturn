import Front from "@frontapp/plugin-sdk";
import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  createDraftDetector,
  createPendingCapture,
  type DraftState,
  decideOnSend,
  inScope,
  type PendingSend,
  quickReasons,
  sentFromMessages,
  settingsFrom,
  statusLine,
} from "./capture";

/**
 * The slice of Front's plugin SDK this app uses, as documented at
 * https://dev.frontapp.com/docs/plugin-sdk: a sidebar plugin receives the open
 * conversation through `contextUpdates`; a composer plugin can read the current
 * draft with `fetchDraft`. There is no send event and no pre-send hook in the SDK,
 * so a send is observed as the new outbound message on the conversation, and
 * `require_reason` holds the capture, never the send (see capture.ts).
 */
interface FrontConversation {
  id: string;
  subject?: string;
  tags?: Array<{ name: string }>;
  recipient?: { name?: string; handle?: string };
  customFields?: Record<string, unknown>;
}
interface FrontMessage {
  id: string;
  body?: string;
  type?: string;
  isInbound?: boolean;
  author?: { name?: string; email?: string };
  createdAt?: number;
}
interface FrontContext {
  type: string;
  conversation?: FrontConversation & { messages?: FrontMessage[] };
  teammate?: { email?: string; name?: string };
  draftId?: string;
}
interface FrontClient {
  contextUpdates: {
    subscribe(observer: (ctx: FrontContext) => void): { unsubscribe(): void };
  };
  fetchDraft(draftId: string): Promise<{ content?: { body?: string } } | null>;
}

const client = Front as unknown as FrontClient;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Plugin settings arrive with the plugin configuration; read them off the page URL. */
function rawSettings(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(location.search)) out[k] = v;
  return out;
}

function snapshotFrom(ctx: FrontContext): ConversationSnapshot | null {
  const c = ctx.conversation;
  if (!c) return null;
  return {
    id: c.id,
    subject: c.subject ?? null,
    recipientName: c.recipient?.name ?? null,
    recipientEmail: c.recipient?.handle ?? null,
    messages: (c.messages ?? []).map((m) => ({
      id: m.id,
      body: m.body ?? "",
      kind: m.type === "comment" || m.type === "note" ? "note" : m.isInbound ? "inbound" : "outbound",
      authorName: m.author?.name ?? null,
      authorEmail: m.author?.email ?? null,
      createdAt: m.createdAt ? new Date(m.createdAt * 1000).toISOString() : null,
    })),
    customFields: c.customFields ?? {},
    url: `https://app.frontapp.com/open/${c.id}`,
  };
}

async function main(): Promise<void> {
  const settings: AppSettings = settingsFrom(rawSettings());
  const apiKey = new URLSearchParams(location.search).get("overturn_api_key") ?? "";
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
  const pending = createPendingCapture();

  const root = document.getElementById("app")!;
  const status = el("div", { class: "status" }, "Waiting for a draft");
  let reasonCode: string | null = null;
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];
  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  }) as HTMLTextAreaElement;
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, mark, note);

  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  let snapshot: ConversationSnapshot | null = null;
  let actor: string | null = null;
  let draftFields: Record<string, unknown> = {};
  const seen = new Set<string>();

  const render = (): void => {
    status.textContent = pending.pending()
      ? "Pick why you changed the reply - the capture is held until you do"
      : statusLine(detector.current(), lastResult);
  };

  const post = async (body: unknown): Promise<void> => {
    const res = await fetch(`${settings.baseUrl}/v1/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`capture ${res.status}`);
    const r = (await res.json()) as CaptureResult;
    lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
    note.textContent = r.changed && r.case ? `Case: ${r.case.title}` : "";
    reason.value = "";
    reasonCode = null;
    for (const c of chips) c.classList.remove("on");
    detector.set(null);
    pending.clear();
    render();
  };

  const runDecision = async (send: PendingSend): Promise<void> => {
    if (!snapshot) return;
    const decision = decideOnSend({
      conversation: snapshot,
      draft: detector.current(),
      draftFields,
      send: { ...send, fields: readFields(snapshot) },
      reasonCode,
      reason: reason.value,
      actor,
      settings,
      now: Date.now(),
    });
    if (decision.action === "skip") return;
    if (decision.action === "need-reason") {
      // Held, not blocked: the reply is already gone; its capture waits for the one click.
      pending.hold(decision, () =>
        decideOnSend({
          conversation: snapshot!,
          draft: detector.current(),
          draftFields,
          send: { ...send, fields: readFields(snapshot!) },
          reasonCode,
          reason: reason.value,
          actor,
          settings,
          now: Date.now(),
        }),
      );
      chips[0]?.focus();
      render();
      return;
    }
    try {
      await post(decision.body);
    } catch {
      // Never block the teammate's work on our failure; say so in the panel.
      note.textContent = "Overturn could not save this correction (network).";
    }
  };

  for (const q of quickReasons(settings)) {
    const b = el(
      "button",
      { type: "button", class: "chip", "data-code": q.code },
      q.label,
    ) as HTMLButtonElement;
    b.addEventListener("click", async () => {
      reasonCode = reasonCode === q.code ? null : q.code;
      for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
      if (pending.pending() && reasonCode) {
        const decision = pending.resolve();
        if (decision?.action === "capture") {
          try {
            await post(decision.body);
          } catch {
            note.textContent = "Overturn could not save this correction (network).";
          }
        }
        render();
      }
    });
    chips.push(b);
    quick.appendChild(b);
  }

  const readFields = (snap: ConversationSnapshot): Record<string, unknown> => {
    if (settings.decisionFields.length === 0) return {};
    return Object.fromEntries(settings.decisionFields.map((f) => [f.label, snap.customFields[f.id] ?? null]));
  };

  mark.addEventListener("click", () => {
    const draft: DraftState | null = detector.current();
    if (draft) return;
    // The composer text reaches the panel through the latest composer context; when the
    // teammate clicks, the current draft body is the last one the SDK handed us.
    if (lastComposerText.trim()) {
      detector.set({ text: lastComposerText, origin: "manual", at: Date.now() });
      lastResult = null;
      render();
    }
  });

  let lastComposerText = "";
  client.contextUpdates.subscribe((ctx) => {
    void (async () => {
      if (ctx.type === "singleConversation" || ctx.conversation) {
        const snap = snapshotFrom(ctx);
        if (!snap) return;
        const tags = ctx.conversation?.tags?.map((t) => t.name) ?? [];
        if (!inScope(tags, settings)) {
          status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
          return;
        }
        snapshot = snap;
        actor = ctx.teammate?.email ?? actor;
        // A drafting agent that recorded its run with the SDK: the draft is its output.
        if (!detector.current() && apiKey) {
          try {
            const res = await fetch(
              `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`fr:${snap.id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
              { headers: { authorization: `Bearer ${apiKey}` } },
            );
            const found = (await res.json()) as {
              items?: Array<{ id: string; output: unknown; agent: string }>;
            };
            const run = found.items?.[0];
            if (run && typeof run.output === "string" && run.output.trim()) {
              detector.set({ text: run.output, origin: "recorded", runId: run.id, at: Date.now() });
              draftFields = readFields(snap);
            }
          } catch {
            // no recorded draft; the composer is watched instead
          }
        }
        const send = sentFromMessages(seen, snap.messages, settings);
        for (const m of snap.messages) seen.add(m.id);
        if (send && detector.current()) {
          await runDecision(send);
        }
        render();
      }
      if (ctx.draftId) {
        try {
          const draft = await client.fetchDraft(ctx.draftId);
          const body = draft?.content?.body ?? "";
          lastComposerText = body;
          if (detector.onComposer(body)) {
            draftFields = snapshot ? readFields(snapshot) : {};
            render();
          }
        } catch {
          // a draft we cannot read is not a draft we capture
        }
      }
    })();
  });
  render();
}

void main();
