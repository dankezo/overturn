import Front, { type ApplicationSingleConversation } from "@frontapp/plugin-sdk";
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
import { type ConversationReader, draftBodyFromReader, rawSettingsFrom, snapshotFromReader } from "./front";

/**
 * Panel wiring over the typed SDK adapter in front.ts. Front's plugin SDK delivers
 * the open conversation through `contextUpdates`; the conversation object carries
 * no messages (they are listed through the context), the composer's draft is read
 * by the draft id on the conversation, and the settings arrive on the context's
 * entry point. There is no send event and no pre-send hook in the SDK, so a send is
 * observed as the new outbound message on the conversation, and `require_reason`
 * holds the capture, never the send (see capture.ts).
 */

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

function apiKeyFrom(raw: Record<string, unknown>): string {
  const value = raw.overturn_api_key;
  return typeof value === "string" ? value : "";
}

async function main(): Promise<void> {
  // Until the first context arrives, the page URL is the only settings source there is.
  let raw = rawSettingsFrom(undefined, location.search);
  let settings: AppSettings = settingsFrom(raw);
  let apiKey = apiKeyFrom(raw);
  let detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
  let detectorMinDraftChars = settings.minDraftChars;
  const pending = createPendingCapture();

  // The entry point's properties replace the URL fallback as soon as a context
  // carries them; a changed minimum draft size rebuilds the detector around the
  // draft it already holds.
  const applyRaw = (next: Record<string, unknown>): void => {
    if (JSON.stringify(next) === JSON.stringify(raw)) return;
    raw = next;
    settings = settingsFrom(raw);
    apiKey = apiKeyFrom(raw);
    if (settings.minDraftChars !== detectorMinDraftChars) {
      const current = detector.current();
      detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
      detector.set(current);
      detectorMinDraftChars = settings.minDraftChars;
    }
  };

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
  let lastComposerText = "";
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

  const feedComposer = (body: string): void => {
    lastComposerText = body;
    if (detector.onComposer(body)) {
      draftFields = snapshot ? readFields(snapshot) : {};
      render();
    }
  };

  const onConversation = async (
    conversation: ApplicationSingleConversation,
    reader: ConversationReader,
    teammateEmail: string,
  ): Promise<void> => {
    const snap = await snapshotFromReader(reader);
    if (!snap) return;
    const tags = conversation.tags.map((t) => t.name);
    if (!inScope(tags, settings)) {
      status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
      return;
    }
    snapshot = snap;
    actor = teammateEmail;
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
  };

  // Context updates are handled one at a time: building a snapshot lists the
  // conversation's messages, and two updates racing would double-count a send.
  let chain: Promise<void> = Promise.resolve();
  Front.contextUpdates.subscribe((ctx) => {
    chain = chain
      .then(async () => {
        applyRaw(rawSettingsFrom(ctx.entryPoint, location.search));
        if (ctx.type === "singleConversation" || ctx.type === "singleConversationPopover") {
          await onConversation(ctx.conversation, ctx, ctx.teammate.email);
          const body = await draftBodyFromReader(ctx).catch(() => null);
          if (body !== null) feedComposer(body);
        } else if (ctx.type === "messageComposer") {
          if (ctx.conversation) await onConversation(ctx.conversation, ctx, ctx.teammate.email);
          feedComposer(ctx.draft.content.body);
        } else if (ctx.type === "noConversationPopover" && ctx.draftId) {
          const draft = await ctx.fetchDraft(ctx.draftId).catch(() => undefined);
          if (draft) feedComposer(draft.content.body);
        }
      })
      .catch(() => {
        // A context that cannot be read changes nothing; the next update is handled fresh.
      });
  });
  render();
}

void main();
