import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** What the plugin knows about the conversation, read through the Front plugin SDK. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  /** The customer the conversation is with, when Front names one. */
  recipientName: string | null;
  recipientEmail: string | null;
  /** Oldest first, as the conversation carries them. */
  messages: Array<{
    id: string;
    /** HTML or plain text, as Front returns message bodies. */
    body: string;
    /** Inbound (customer), outbound (teammate) or an internal comment/note. */
    kind: "inbound" | "outbound" | "note" | string;
    authorName?: string | null;
    authorEmail?: string | null;
    createdAt?: string | null;
  }>;
  /** Conversation custom-field attributes by field name. */
  customFields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Hold a changed reply's capture until the teammate picks a reason (claims pack default). */
  requireReason: boolean;
  /** Also capture internal comments, not only outbound replies. */
  captureInternalNotes: boolean;
  /** Conversation custom fields that *are* the decision, by label: `status:status, total:total`. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the plugin watches only conversations carrying this tag; others are never read. */
  scopeTag: string | null;
  /** Which quick-pick reasons the teammate sees: the claims pack or the support pack. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  // The Front surface is installed per workflow like the claims app: the picker shows the
  // claims pack's eight codes unless the installer picks the support pack instead.
  reasonPack: "claims",
};

/** Parses the plugin's settings (strings and booleans from the plugin configuration). */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return d;
  };
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    // An absent reason_pack keeps this surface's default (claims); an explicit one is honoured.
    reasonPack: str("reason_pack") ? reasonPackFrom(str("reason_pack")) : DEFAULT_SETTINGS.reasonPack,
  };
}

/**
 * Whether the plugin should watch this conversation at all. With no scope tag every
 * conversation is watched, but nothing is read beyond the composer until a draft appears
 * (see main.ts). With a scope tag, conversations without it are never read at all.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from. The composer is watched: the first time it goes from (nearly)
 * empty to a reply-sized text in one change, that text was inserted (an AI assist, a macro,
 * a paste), not typed, and it is the draft. The teammate can also mark the current text as
 * the draft by hand, and a drafting agent that recorded its run with the SDK is found by
 * conversation id.
 */
export type DraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface DraftDetector {
  /** Feed every composer value; returns a draft the first time one appears. */
  onComposer(text: string, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now()) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      // A jump of reply size in one change (or a reply-sized composer on first sight).
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: first ? "preloaded" : "inserted", at: now };
        return draft;
      }
      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

function role(m: ConversationSnapshot["messages"][number]): CaptureMessage["role"] {
  if (m.kind === "note") return "note";
  return m.kind === "outbound" ? "agent" : "customer";
}

/** The thread the teammate saw, oldest first, as capture context. */
export function contextFrom(conversation: ConversationSnapshot): CaptureMessage[] {
  return conversation.messages
    .filter((m) => m.body?.trim())
    .map((m) => ({
      role: role(m),
      author: m.authorEmail ?? m.authorName ?? null,
      content: stripHtml(m.body),
      at: m.createdAt ?? null,
    }));
}

/** Front hands message bodies back as HTML; the case wants the text the human read. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

export interface PendingSend {
  text: string;
  type: "publicReply" | "internalNote" | string;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when the teammate sends. Pure: the Front glue only forwards the answer. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  /** The picked reason code, required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the send happened; with the draft's `at`, gives how long it sat in front of the reviewer. */
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "internalNote" && !settings.captureInternalNotes)
    return { action: "skip", why: "internal-note" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "front",
    externalId: conversation.id.startsWith("fr:") ? conversation.id : `fr:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject,
    context: contextFrom(conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversation.url,
    tags: [`draft:${draft.origin}`, send.type === "internalNote" ? "internal-note" : "public-reply"],
    metadata: { requester: conversation.recipientEmail ?? conversation.recipientName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/**
 * The send, as the plugin can observe it: Front's plugin SDK has no send event and no
 * pre-send hook, but a sent reply appears on the conversation as a new outbound message.
 * Given the message ids already seen and the conversation's current messages, returns the
 * first outbound message that was not there before, or null. Internal comments are only a
 * send when the app is configured to capture them.
 */
export function sentFromMessages(
  seenIds: ReadonlySet<string>,
  messages: ConversationSnapshot["messages"],
  settings: AppSettings,
): PendingSend | null {
  for (const m of messages) {
    if (seenIds.has(m.id)) continue;
    if (m.kind === "outbound") return { text: m.body, type: "publicReply", fields: {} };
    if (m.kind === "note" && settings.captureInternalNotes)
      return { text: m.body, type: "internalNote", fields: {} };
  }
  return null;
}

/**
 * A changed send that is waiting for its reason. Front gives plugins no pre-send hook, so
 * `require_reason` cannot stop the send itself; what it holds is the capture. The send is
 * kept here, the panel asks for the one click, and `resolve` re-runs the decision with the
 * picked code so the capture posts complete instead of reason-less.
 */
export interface PendingCapture {
  hold(decision: SendDecision, retry: () => SendDecision): boolean;
  pending(): boolean;
  resolve(): SendDecision | null;
  clear(): void;
}

export function createPendingCapture(): PendingCapture {
  let retry: (() => SendDecision) | null = null;
  return {
    hold(decision, fn) {
      if (decision.action !== "need-reason") return false;
      retry = fn;
      return true;
    },
    pending: () => retry !== null,
    resolve() {
      if (!retry) return null;
      const fn = retry;
      retry = null;
      return fn();
    },
    clear() {
      retry = null;
    },
  };
}

/** Short status line for the panel. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).length;
  const from = {
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** The chips the teammate clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
