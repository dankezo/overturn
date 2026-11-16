import {
  type AppSettings,
  type DraftOrigin,
  type DraftState,
  draftOriginFrom,
  quickReasons,
  statusLine,
} from "./capture";

/**
 * The Canvas Kit components this app renders, as typed JSON. Intercom's Canvas Kit is a
 * closed component vocabulary; these are the components the capture form needs, modelled
 * after https://developers.intercom.com/docs/canvas-kit so the builders stay pure and
 * testable without a live workspace.
 */
export type Component =
  | { type: "text"; id: string; text: string; style?: "header" | "paragraph" | "muted" | "error" }
  | { type: "textarea"; id: string; label: string; value?: string; placeholder?: string }
  | {
      type: "single-select";
      id: string;
      label: string;
      value?: string;
      options: Array<{ type: "option"; id: string; text: string }>;
    }
  | { type: "button"; id: string; label: string; style: "primary"; action: { type: "submit" } };

export interface Canvas {
  content: { components: Component[] };
}

export interface CaptureForm {
  draftText: string;
  sentText: string;
  origin: DraftOrigin;
  reasonCode: string | null;
  note: string;
}

export const EMPTY_FORM: CaptureForm = {
  draftText: "",
  sentText: "",
  origin: "unknown",
  reasonCode: null,
  note: "",
};

/** The form values a submit payload carries back, parsed defensively. */
export function formFrom(input: Record<string, unknown>): CaptureForm {
  const str = (k: string): string => (typeof input[k] === "string" ? (input[k] as string) : "");
  return {
    draftText: str("draft_text"),
    sentText: str("sent_text"),
    origin: draftOriginFrom(input.draft_origin),
    reasonCode: str("reason_code") || null,
    note: str("reason_note"),
  };
}

const ORIGIN_OPTIONS: Array<{ type: "option"; id: string; text: string }> = [
  { type: "option", id: "unknown", text: "Not sure" },
  { type: "option", id: "ai", text: "Written by an AI assist (Fin, a macro, a paste)" },
  { type: "option", id: "manual", text: "I wrote it" },
];

/**
 * The canvas for one conversation. Before a draft exists the app renders only the waiting
 * line: a conversation with no draft in it is never read, so there is nothing else to show.
 * With a draft, the form carries the draft, what was sent, where the draft came from, and
 * the one-click reason.
 */
export function captureCanvas(opts: {
  draft: DraftState | null;
  form: CaptureForm;
  settings: AppSettings;
  message?: { text: string; style: "error" | "muted" } | null;
  lastResult?: { kind: string; changed: boolean; dedup: boolean } | null;
}): Canvas {
  const { draft, form, settings } = opts;
  const components: Component[] = [
    { type: "text", id: "status", text: statusLine(draft, opts.lastResult ?? null), style: "header" },
  ];
  if (opts.message) {
    components.push({ type: "text", id: "message", text: opts.message.text, style: opts.message.style });
  }
  // After a save, the panel is just the result line; before a draft, just the waiting line.
  if (opts.lastResult || !draft) return { content: { components } };

  components.push(
    {
      type: "textarea",
      id: "draft_text",
      label: "The draft (what the AI or the assist produced)",
      value: form.draftText,
      placeholder: "Paste the draft, or leave blank if a recorded run supplied it",
    },
    {
      type: "textarea",
      id: "sent_text",
      label: "What you sent",
      value: form.sentText || form.draftText,
    },
    {
      type: "single-select",
      id: "draft_origin",
      label: "Where did the draft come from?",
      value: form.origin,
      options: ORIGIN_OPTIONS,
    },
    {
      type: "single-select",
      id: "reason_code",
      label: "Why did you change it? (one click)",
      ...(form.reasonCode ? { value: form.reasonCode } : {}),
      options: quickReasons(settings).map((r) => ({ type: "option" as const, id: r.code, text: r.label })),
    },
    { type: "textarea", id: "reason_note", label: "Anything else? Optional.", value: form.note },
    { type: "button", id: "save", label: "Save capture", style: "primary", action: { type: "submit" } },
  );
  return { content: { components } };
}
