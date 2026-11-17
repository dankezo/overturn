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
import {
  type ConversationReader,
  customFieldsFrom,
  type DraftReader,
  draftBodyFromReader,
  rawSettingsFrom,
  snapshotFromReader,
} from "./front";

/**
 * Panel wiring over the typed SDK adapter in front.ts. Front's plugin SDK delivers
 * the open conversation through `contextUpdates`; the conversation object carries
 * no messages (they are listed through the context), the composer's draft is read
 * by the draft id on the conversation, and the settings arrive on the context's
 * entry point. There is no send event and no pre-send hook in the SDK, so a send is
 * observed as the new outbound message on the conversation, and `require_reason`
 * holds the capture, never the send (see capture.ts).
 *
 * Two rules shape this glue. First, nothing about a conversation is read until a
 * draft is armed: the messages are listed only to look for a send, never on
 * opening a conversation (reading a conversation with no draft in it is out of
 * scope). Second, all draft state is per conversation: switching conversations
 * resets it, so a draft armed on one thread can never be charged with another
 * thread's older outbound message.
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
  // Per-conversation watch: the conversation the panel is currently on, and whether
  // it is in scope. The draft the pending capture was built from: posting it must
  // not wipe a draft armed on another conversation since.
  let currentConversationId: string | null = null;
  let watchingCurrent = true;
  let heldDraft: DraftState | null = null;
  // The latest conversation context, for the send-detection poll below.
  let lastConversation: ApplicationSingleConversation | null = null;
  let lastReader: (ConversationReader & Partial<DraftReader>) | null = null;
  let lastTeammateEmail = "";

  const render = (): void => {
    status.textContent = pending.pending()
      ? "Pick why you changed the reply - the capture is held until you do"
      : statusLine(detector.current(), lastResult);
  };

  const readFields = (customFields: Record<string, unknown>): Record<string, unknown> => {
    if (settings.decisionFields.length === 0) return {};
    return Object.fromEntries(settings.decisionFields.map((f) => [f.label, customFields[f.id] ?? null]));
  };

  const fieldsForConversation = (
    conversation: ApplicationSingleConversation | undefined,
  ): Record<string, unknown> =>
    conversation ? readFields(customFieldsFrom(conversation.customFieldAttributes)) : {};

  /**
   * Fresh per-conversation state for a newly opened conversation. A held capture
   * is deliberately kept: its retry is bound to the held conversation and draft,
   * so the teammate can still pick a reason and post it after switching away.
   */
  const resetPerConversation = (): void => {
    detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
    detectorMinDraftChars = settings.minDraftChars;
    lastResult = null;
    draftFields = {};
    lastComposerText = "";
    snapshot = null;
    actor = null;
    note.textContent = "";
    if (!pending.pending()) {
      reasonCode = null;
      reason.value = "";
      for (const c of chips) c.classList.remove("on");
    }
    render();
  };

  const post = async (body: unknown, draft: DraftState | null): Promise<void> => {
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
    // Only clear the armed draft when this capture was built from it: a held capture
    // posted after switching conversations must not wipe the new conversation's draft.
    if (draft && detector.current() === draft) detector.set(null);
    heldDraft = null;
    pending.clear();
    render();
  };

  const runDecision = async (send: PendingSend): Promise<void> => {
    if (!snapshot) return;
    const decision = decideOnSend({
      conversation: snapshot,
      draft: detector.current(),
      draftFields,
      send: { ...send, fields: readFields(snapshot.customFields) },
      reasonCode,
      reason: reason.value,
      actor,
      settings,
      now: Date.now(),
    });
    if (decision.action === "skip") return;
    if (decision.action === "need-reason") {
      // Held, not blocked: the reply is already gone; its capture waits for the one click.
      // Bind the held values now: the teammate may switch conversations before picking
      // a reason, and the retry must still decide the held conversation's capture,
      // not whatever conversation and draft the panel shows by then.
      const heldSnapshot = snapshot;
      const heldDraftNow = detector.current()!;
      const heldFields = draftFields;
      const heldActor = actor;
      const heldSettings = settings;
      const heldSend = { ...send, fields: readFields(snapshot.customFields) };
      heldDraft = heldDraftNow;
      pending.hold(decision, () =>
        decideOnSend({
          conversation: heldSnapshot,
          draft: heldDraftNow,
          draftFields: heldFields,
          send: heldSend,
          reasonCode,
          reason: reason.value,
          actor: heldActor,
          settings: heldSettings,
          now: Date.now(),
        }),
      );
      chips[0]?.focus();
      render();
      return;
    }
    try {
      await post(decision.body, detector.current());
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
            await post(decision.body, heldDraft);
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

  const feedComposer = (body: string, fields: Record<string, unknown>): void => {
    lastComposerText = body;
    if (detector.onComposer(body)) {
      draftFields = fields;
      render();
    }
  };

  const onConversation = async (
    conversation: ApplicationSingleConversation,
    reader: ConversationReader & Partial<DraftReader>,
    teammateEmail: string,
  ): Promise<void> => {
    // A draft armed on one conversation must never leak into the next one: without
    // this reset, switching conversations with a draft armed would read the new
    // thread's oldest outbound message as that draft's send.
    if (currentConversationId !== null && currentConversationId !== conversation.id) {
      resetPerConversation();
    }
    currentConversationId = conversation.id;
    const tags = conversation.tags.map((t) => t.name);
    if (!inScope(tags, settings)) {
      watchingCurrent = false;
      status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
      return;
    }
    watchingCurrent = true;
    actor = teammateEmail;
    const fieldsNow = fieldsForConversation(conversation);
    const hadDraft = detector.current();
    // A drafting agent that recorded its run with the SDK: the draft is its output.
    // This queries the runs API for this conversation id only; the conversation
    // itself is not read.
    if (!hadDraft && apiKey) {
      try {
        const res = await fetch(
          `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`fr:${conversation.id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
          { headers: { authorization: `Bearer ${apiKey}` } },
        );
        const found = (await res.json()) as {
          items?: Array<{ id: string; output: unknown; agent: string }>;
        };
        const run = found.items?.[0];
        if (run && typeof run.output === "string" && run.output.trim()) {
          detector.set({ text: run.output, origin: "recorded", runId: run.id, at: Date.now() });
          draftFields = fieldsNow;
        }
      } catch {
        // no recorded draft; the composer is watched instead
      }
    }
    // The composer's draft, fetched by id only. Still no message read: until a draft
    // is armed, the conversation itself is never listed.
    if (reader.fetchDraft) {
      const body = await draftBodyFromReader({ conversation, fetchDraft: reader.fetchDraft }).catch(
        () => null,
      );
      if (body !== null) feedComposer(body, fieldsNow);
    }
    if (!detector.current()) return;
    // Only now, with a draft armed, list the messages: to look for its send.
    const snap = await snapshotFromReader(reader);
    if (!snap) return;
    snapshot = snap;
    // A draft armed by this very update must not turn a message that predates it
    // into its send: baseline the thread first.
    if (!hadDraft && detector.current()) {
      for (const m of snap.messages) seen.add(m.id);
    }
    const send = sentFromMessages(seen, snap.messages, settings);
    for (const m of snap.messages) seen.add(m.id);
    if (send) {
      await runDecision(send);
    }
    render();
  };

  mark.addEventListener("click", () => {
    if (!watchingCurrent) return;
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

  // Context updates are handled one at a time: building a snapshot lists the
  // conversation's messages, and two updates racing would double-count a send.
  let chain: Promise<void> = Promise.resolve();
  Front.contextUpdates.subscribe((ctx) => {
    chain = chain
      .then(async () => {
        applyRaw(rawSettingsFrom(ctx.entryPoint, location.search));
        if (ctx.type === "singleConversation" || ctx.type === "singleConversationPopover") {
          lastConversation = ctx.conversation;
          lastReader = ctx;
          lastTeammateEmail = ctx.teammate.email;
          await onConversation(ctx.conversation, ctx, ctx.teammate.email);
        } else if (ctx.type === "messageComposer") {
          if (ctx.conversation) {
            lastConversation = ctx.conversation;
            lastReader = ctx;
            lastTeammateEmail = ctx.teammate.email;
            await onConversation(ctx.conversation, ctx, ctx.teammate.email);
          }
          feedComposer(ctx.draft.content.body, fieldsForConversation(ctx.conversation));
        } else if (ctx.type === "noConversationPopover" && ctx.draftId) {
          const draft = await ctx.fetchDraft(ctx.draftId).catch(() => undefined);
          if (draft) feedComposer(draft.content.body, {});
        } else {
          // No conversation in view: the poll has nothing to re-check.
          lastConversation = null;
          lastReader = null;
        }
      })
      .catch(() => {
        // A context that cannot be read changes nothing; the next update is handled fresh.
      });
  });

  // Front sends no context update while the teammate types, and the update that
  // follows a send can lag the message list, so re-check for the send of an armed
  // draft on a short timer. The tick only lists messages while a draft is armed
  // and no capture is held; idle ticks do no work, and a failed tick is swallowed.
  const pollOnce = (): void => {
    if (!lastConversation || !lastReader || !detector.current() || pending.pending()) return;
    const conversation = lastConversation;
    const reader = lastReader;
    const email = lastTeammateEmail;
    chain = chain
      .then(() => onConversation(conversation, reader, email))
      .catch(() => {
        // A poll that cannot read changes nothing; the next tick tries again.
      });
  };
  setInterval(pollOnce, 2000);

  render();
}

void main();
