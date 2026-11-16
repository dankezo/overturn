import { createHmac, timingSafeEqual } from "node:crypto";
import type { CaptureResult } from "@overturn-ai/shared";
import { type CaptureForm, captureCanvas, EMPTY_FORM, formFrom } from "./canvas";
import {
  type AppSettings,
  type ConversationSnapshot,
  type DraftState,
  decideOnSend,
  settingsFrom,
} from "./capture";

export interface ServerConfig {
  /** Intercom app client secret, used to verify webhook signatures. */
  clientSecret: string;
  /** Overturn project API key, sent as the capture bearer token. */
  apiKey: string;
  settings: AppSettings;
}

export function configFromEnv(env: Record<string, string | undefined>): ServerConfig {
  return {
    clientSecret: env.INTERCOM_CLIENT_SECRET ?? "",
    apiKey: env.OVERTURN_API_KEY ?? "",
    settings: settingsFrom({
      overturn_base_url: env.OVERTURN_BASE_URL,
      agent: env.OVERTURN_AGENT,
      reason_pack: env.OVERTURN_REASON_PACK,
      require_reason: env.OVERTURN_REQUIRE_REASON,
      capture_internal_notes: env.OVERTURN_CAPTURE_INTERNAL_NOTES,
      min_draft_chars: env.OVERTURN_MIN_DRAFT_CHARS,
    }),
  };
}

/** Intercom signs the raw body with the app's client secret (HMAC-SHA256, hex). */
export function validSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Deps {
  config: ServerConfig;
  /** Finds a run a drafting agent recorded for this conversation, if any. */
  findRecordedDraft(conversationId: string): Promise<DraftState | null>;
  /** Posts a decided capture body to Overturn. */
  postCapture(body: unknown): Promise<CaptureResult>;
}

/** The production deps: plain fetches against the Overturn API. */
export function httpDeps(config: ServerConfig): Deps {
  const headers = { authorization: `Bearer ${config.apiKey}` };
  return {
    config,
    async findRecordedDraft(conversationId) {
      try {
        const res = await fetch(
          `${config.settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`ic:${conversationId}`)}&agent=${encodeURIComponent(config.settings.agent)}&limit=1`,
          { headers },
        );
        if (!res.ok) return null;
        const found = (await res.json()) as { items?: Array<{ id: string; output: unknown }> };
        const run = found.items?.[0];
        if (run && typeof run.output === "string" && run.output.trim()) {
          // A recorded run is an assist's output by definition: the origin is `ai`, told to
          // us by the SDK, never guessed.
          return { text: run.output, origin: "ai", runId: run.id, at: Date.now() };
        }
      } catch {
        // no recorded draft; the form is filled by hand instead
      }
      return null;
    },
    async postCapture(body) {
      const res = await fetch(`${config.settings.baseUrl}/v1/capture`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`capture ${res.status}`);
      return (await res.json()) as CaptureResult;
    },
  };
}

/** The conversation slice a Canvas Kit payload carries, normalised to the snapshot shape. */
export function conversationFrom(payload: Record<string, unknown>): ConversationSnapshot {
  const ctx = (payload.context ?? {}) as Record<string, unknown>;
  const conv = (ctx.conversation ?? payload.conversation ?? {}) as Record<string, unknown>;
  const id = String(conv.id ?? ctx.conversation_id ?? "");
  const parts = Array.isArray(conv.parts) ? (conv.parts as Array<Record<string, unknown>>) : [];
  return {
    id,
    subject: typeof conv.title === "string" ? conv.title : null,
    customerName: null,
    customerEmail: null,
    messages: parts.map((p, i) => ({
      id: String(p.id ?? i),
      body: typeof p.body === "string" ? p.body : "",
      kind: p.part_type === "note" ? "note" : p.author_type === "admin" ? "agent" : "customer",
      authorEmail: typeof p.author_email === "string" ? p.author_email : null,
      createdAt: typeof p.created_at === "string" ? p.created_at : null,
    })),
    url: id ? `https://app.intercom.com/a/apps/_/inbox/inbox/admin/all/conversation/${id}` : null,
  };
}

export interface HandlerRequest {
  method: string;
  path: string;
  rawBody: string;
  signature?: string;
}

export interface HandlerResponse {
  status: number;
  body: unknown;
}

/**
 * The Canvas Kit flow, as a pure handler: verify the signature, then initialize renders
 * the form for the conversation (with a recorded draft when one exists), and submit runs
 * the send decision - a changed reply with no reason re-renders with an error and posts
 * nothing, because the form is this surface's enforceable moment; the Intercom send
 * itself is never blocked by anything here.
 */
export function createHandler(deps: Deps) {
  const { config } = deps;
  return async (req: HandlerRequest): Promise<HandlerResponse> => {
    if (req.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
    if (!validSignature(req.rawBody, req.signature, config.clientSecret)) {
      return { status: 401, body: { error: "bad signature" } };
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody) as Record<string, unknown>;
    } catch {
      return { status: 400, body: { error: "bad json" } };
    }
    const conversation = conversationFrom(payload);
    if (!conversation.id) return { status: 400, body: { error: "no conversation" } };
    const admin = (payload.admin ?? {}) as Record<string, unknown>;
    const actor = typeof admin.email === "string" ? admin.email : null;

    if (req.path.endsWith("/initialize")) {
      const recorded = await deps.findRecordedDraft(conversation.id);
      const form: CaptureForm = recorded
        ? { ...EMPTY_FORM, draftText: recorded.text, sentText: recorded.text, origin: "ai" }
        : EMPTY_FORM;
      return {
        status: 200,
        body: {
          canvas: captureCanvas({ draft: recorded, form, settings: config.settings }),
        },
      };
    }

    if (req.path.endsWith("/submit")) {
      const input = (payload.input_values ?? {}) as Record<string, unknown>;
      const form = formFrom(input);
      const recorded = await deps.findRecordedDraft(conversation.id);
      const draft: DraftState | null =
        form.draftText.trim() || recorded
          ? {
              text: form.draftText.trim() ? form.draftText : (recorded?.text ?? ""),
              origin: form.origin,
              runId: recorded?.runId,
              model: recorded?.model ?? null,
              at: recorded?.at ?? Date.now(),
            }
          : null;
      const decision = decideOnSend({
        conversation,
        draft,
        send: { text: form.sentText, type: "publicReply" },
        reasonCode: form.reasonCode,
        reason: form.note,
        actor,
        settings: config.settings,
        now: Date.now(),
      });
      if (decision.action === "need-reason") {
        return {
          status: 200,
          body: {
            canvas: captureCanvas({
              draft,
              form,
              settings: config.settings,
              message: {
                text: "Pick why you changed the reply - one click - to save this capture.",
                style: "error",
              },
            }),
          },
        };
      }
      if (decision.action === "skip") {
        return {
          status: 200,
          body: {
            canvas: captureCanvas({
              draft,
              form,
              settings: config.settings,
              message: {
                text:
                  decision.why === "no-draft"
                    ? "Nothing to capture yet: no draft on this conversation."
                    : "Nothing to capture from that submission.",
                style: "muted",
              },
            }),
          },
        };
      }
      try {
        const r = await deps.postCapture(decision.body);
        return {
          status: 200,
          body: {
            canvas: captureCanvas({
              draft: null,
              form: EMPTY_FORM,
              settings: config.settings,
              lastResult: { kind: r.kind, changed: r.changed, dedup: r.deduplicated },
            }),
          },
        };
      } catch {
        // The form says what happened; a failed capture changes nothing in Intercom.
        return {
          status: 200,
          body: {
            canvas: captureCanvas({
              draft,
              form,
              settings: config.settings,
              message: { text: "Overturn could not save this correction (network).", style: "error" },
            }),
          },
        };
      }
    }

    return { status: 404, body: { error: "not found" } };
  };
}
