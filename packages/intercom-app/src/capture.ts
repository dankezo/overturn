import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** What the app knows about the conversation, read from the Canvas Kit payloads. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  /** The customer the conversation is with, when Intercom names one. */
  customerName: string | null;
  customerEmail: string | null;
  /** Oldest first, as the conversation carries them. */
  messages: Array<{
    id: string;
    body: string;
    /** Customer reply, teammate reply, or an internal note. */
    kind: "customer" | "agent" | "note" | string;
    authorName?: string | null;
    authorEmail?: string | null;
    createdAt?: string | null;
  }>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Refuse the capture form for a changed reply until the teammate picks a reason. */
  requireReason: boolean;
  /** Also capture internal notes, not only public replies. */
  captureInternalNotes: boolean;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** Which quick-pick reasons the teammate sees: the support pack by default on this surface. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  minDraftChars: 80,
  reasonPack: "support",
};

/** Parses the app's configuration (environment / app settings, strings and booleans). */
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
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/**
 * Where the draft came from, as the run is tagged. `ai` only when an assist produced the
 * draft (a Fin draft, or a run a drafting agent recorded with the SDK); `manual` when the
 * human typed it; `unknown` when nobody said. Guessing an origin we were not told is worse
 * than `unknown`, so the form starts at `unknown` and only a person (or a recorded run)
 * moves it.
 */
export type DraftOrigin = "ai" | "manual" | "unknown";

export function draftOriginFrom(raw: unknown): DraftOrigin {
  return raw === "ai" || raw === "manual" ? raw : "unknown";
}

/** The tag the run carries for its origin - always present, `draft:unknown` included. */
export function draftTag(origin: DraftOrigin): string {
  return `draft:${origin}`;
}

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

function role(m: ConversationSnapshot["messages"][number]): CaptureMessage["role"] {
  if (m.kind === "note") return "note";
  return m.kind === "agent" ? "agent" : "customer";
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

/** Intercom hands message bodies back as HTML; the case wants the text the human read. */
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
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" | "draft-too-short" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when the teammate submits the capture form. Pure: the server only forwards. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  send: PendingSend;
  /** The picked reason code (support pack), required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the form was submitted; with the draft's `at`, gives how long it sat in front of the reviewer. */
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "internalNote" && !settings.captureInternalNotes)
    return { action: "skip", why: "internal-note" };
  if (!draft) return { action: "skip", why: "no-draft" };
  const draftText = stripHtml(draft.text);
  if (draftText.length < settings.minDraftChars) return { action: "skip", why: "draft-too-short" };

  const draftAnswer: CaptureAnswer = { text: draftText };
  const sentAnswer: CaptureAnswer = { text: sentText };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "intercom",
    externalId: conversation.id.startsWith("ic:") ? conversation.id : `ic:${conversation.id}`,
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
    tags: [draftTag(draft.origin), send.type === "internalNote" ? "internal-note" : "public-reply"],
    metadata: { requester: conversation.customerEmail ?? conversation.customerName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the canvas. */
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
  return `Draft inserted · ${words} words`;
}

/** The reasons the teammate picks from, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
