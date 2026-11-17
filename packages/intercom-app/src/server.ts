import { createHmac, timingSafeEqual } from "node:crypto";
import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import { type CaptureForm, captureCanvas, EMPTY_FORM, formFrom } from "./canvas";
import {
  type AppSettings,
  acceptDraft,
  type ConversationSnapshot,
  type DraftState,
  decideOnSend,
  draftOriginFrom,
  fieldsFrom,
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
      decision_fields: env.OVERTURN_DECISION_FIELDS,
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

/**
 * Intercom signs webhook deliveries with the same client secret, but HMAC-SHA1 of the raw
 * body, sent as `sha1=<hex>`. A missing secret never verifies: an unsigned webhook is
 * refused, not waved through.
 */
export function validWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signature) return false;
  const expected = `sha1=${createHmac("sha1", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What the app remembers per conversation between the panel opening and the reply going out. */
export interface ConversationState {
  draft: DraftState | null;
  /** Decision-field values as they were when the draft was stored. */
  draftFields: Record<string, unknown>;
  reasonCode: string | null;
  note: string;
  /** A changed reply that went out before a reason was picked; posted once there is one. */
  held: { body: CaptureCreate; changed: boolean; changedFields: string[]; partId: string | null } | null;
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null;
  message: string;
  /** Webhook part ids already captured, so a redelivery never captures twice. */
  capturedPartIds: string[];
}

export const freshState = (): ConversationState => ({
  draft: null,
  draftFields: {},
  reasonCode: null,
  note: "",
  held: null,
  lastResult: null,
  message: "",
  capturedPartIds: [],
});

/** Per-conversation memory. In memory by default; pass a shared store for several instances. */
export interface Store {
  get(id: string): Promise<ConversationState | undefined>;
  set(id: string, state: ConversationState): Promise<void>;
}

export function memoryStore(): Store {
  const states = new Map<string, ConversationState>();
  return {
    get: async (id) => states.get(id),
    set: async (id, state) => {
      states.set(id, state);
    },
  };
}

export interface Deps {
  config: ServerConfig;
  /** Finds a run a drafting agent recorded for this conversation, if any. */
  findRecordedDraft(conversationId: string): Promise<DraftState | null>;
  /** Posts a decided capture body to Overturn. */
  postCapture(body: unknown): Promise<CaptureResult>;
  /** Where drafts and held captures live between calls; a fresh in-memory store by default. */
  store?: Store;
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
export function conversationFrom(
  payload: Record<string, unknown>,
  settings: AppSettings,
): ConversationSnapshot {
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
      kind:
        p.part_type === "note"
          ? "note"
          : p.author_type === "bot"
            ? "bot"
            : p.author_type === "admin"
              ? "agent"
              : "customer",
      authorEmail: typeof p.author_email === "string" ? p.author_email : null,
      createdAt: typeof p.created_at === "string" ? p.created_at : null,
    })),
    fields: fieldsFrom((conv.custom_attributes ?? null) as Record<string, unknown> | null, settings),
    url: id ? `https://app.intercom.com/a/apps/_/inbox/inbox/admin/all/conversation/${id}` : null,
  };
}

type WebhookPart = Record<string, unknown>;

/** The opening message plus every part, as a webhook item / REST conversation carries them. */
function webhookParts(item: Record<string, unknown>): WebhookPart[] {
  const out: WebhookPart[] = [];
  const source = item.source;
  if (source && typeof source === "object" && !Array.isArray(source)) out.push(source as WebhookPart);
  const list = (item.conversation_parts as Record<string, unknown> | undefined)?.conversation_parts;
  if (Array.isArray(list)) {
    for (const p of list) {
      if (p && typeof p === "object" && !Array.isArray(p)) out.push(p as WebhookPart);
    }
  }
  return out;
}

function partAuthor(p: WebhookPart): { type: string; name: string | null; email: string | null } {
  const author = (p.author ?? {}) as Record<string, unknown>;
  return {
    type: typeof author.type === "string" ? author.type : "",
    name: typeof author.name === "string" ? author.name : null,
    email: typeof author.email === "string" ? author.email : null,
  };
}

/**
 * The conversation slice a `conversation.admin.*` webhook item carries. The part that just
 * went out is left out of the messages by id: the context is the thread as it was before
 * the reply, and the reply itself is the `sent` answer, not context.
 */
export function conversationFromWebhook(
  item: Record<string, unknown>,
  settings: AppSettings,
  excludePartId?: string | null,
): ConversationSnapshot {
  const id = String(item.id ?? "");
  const contacts = (item.contacts as Record<string, unknown> | undefined)?.contacts;
  const contact =
    Array.isArray(contacts) && contacts[0] && typeof contacts[0] === "object"
      ? (contacts[0] as Record<string, unknown>)
      : null;
  return {
    id,
    subject: typeof item.title === "string" ? item.title : null,
    customerName: typeof contact?.name === "string" ? (contact.name as string) : null,
    customerEmail: typeof contact?.email === "string" ? (contact.email as string) : null,
    messages: webhookParts(item)
      .filter((p) => !(excludePartId && p.id === excludePartId))
      .map((p, i) => {
        const author = partAuthor(p);
        return {
          id: String(p.id ?? i),
          body: typeof p.body === "string" ? p.body : "",
          kind:
            p.part_type === "note"
              ? "note"
              : author.type === "bot"
                ? "bot"
                : author.type === "admin" || author.type === "team"
                  ? "agent"
                  : "customer",
          authorName: author.name,
          authorEmail: author.email,
          createdAt: typeof p.created_at === "number" ? new Date(p.created_at * 1000).toISOString() : null,
        };
      }),
    fields: fieldsFrom((item.custom_attributes ?? null) as Record<string, unknown> | null, settings),
    url: id ? `https://app.intercom.com/a/apps/_/inbox/inbox/admin/all/conversation/${id}` : null,
  };
}

export interface HandlerRequest {
  method: string;
  path: string;
  rawBody: string;
  signature?: string;
  hubSignature?: string;
}

export interface HandlerResponse {
  status: number;
  body: unknown;
}

const SKIP_MESSAGES: Record<string, string> = {
  "no-draft": "Nothing to capture yet: no draft on this conversation.",
  "draft-too-short": "That draft is shorter than the minimum draft length, so it is not captured.",
  "internal-note": "Internal notes are not captured unless capture_internal_notes is on.",
  empty: "Nothing to capture from that submission.",
};

/**
 * The Canvas Kit flow, as a pure handler: verify the signature, then initialize renders
 * the form for the conversation (with a recorded draft when one exists), and submit runs
 * the send decision - a changed reply with no reason re-renders with an error and posts
 * nothing, because the form is this surface's enforceable moment; the Intercom send
 * itself is never blocked by anything here. The webhook flow is the other half: a
 * `conversation.admin.replied` delivery carries the reply that actually went out, so the
 * capture no longer depends on the teammate re-typing what they sent.
 */
export function createHandler(deps: Deps) {
  const { config } = deps;
  const store = deps.store ?? memoryStore();

  const load = async (id: string): Promise<ConversationState> => (await store.get(id)) ?? freshState();

  /** A recorded run becomes the stored draft, so a later webhook can use it. */
  const storeRecordedDraft = async (
    id: string,
    state: ConversationState,
    fields: Record<string, unknown>,
  ): Promise<void> => {
    if (state.draft) return;
    const recorded = await deps.findRecordedDraft(id);
    const draft = recorded ? acceptDraft(recorded.text, recorded.origin, config.settings, recorded.at) : null;
    if (!draft) return;
    state.draft = { ...draft, runId: recorded?.runId, model: recorded?.model ?? null };
    state.draftFields = fields;
    state.lastResult = null;
  };

  const render = (state: ConversationState, form: CaptureForm) => ({
    status: 200,
    body: {
      canvas: captureCanvas({
        draft: state.draft,
        form,
        settings: config.settings,
        held: state.held,
        lastResult: state.lastResult,
        message: state.message ? { text: state.message, style: "muted" as const } : null,
      }),
    },
  });

  const initialize = async (payload: Record<string, unknown>): Promise<HandlerResponse> => {
    const conversation = conversationFrom(payload, config.settings);
    if (!conversation.id) return { status: 400, body: { error: "no conversation" } };
    const state = await load(conversation.id);
    await storeRecordedDraft(conversation.id, state, conversation.fields);
    const form: CaptureForm = state.draft
      ? {
          ...EMPTY_FORM,
          draftText: state.draft.text,
          sentText: state.draft.text,
          origin: state.draft.origin,
        }
      : EMPTY_FORM;
    if (state.reasonCode) form.reasonCode = state.reasonCode;
    if (state.note) form.note = state.note;
    if (state.held?.body.reasonCode) form.reasonCode = state.held.body.reasonCode;
    if (state.held?.body.reason && !form.note) form.note = state.held.body.reason;
    const shown = state.message;
    state.message = "";
    await store.set(conversation.id, state);
    if (!shown) return render(state, form);
    return {
      status: 200,
      body: {
        canvas: captureCanvas({
          draft: state.draft,
          form,
          settings: config.settings,
          held: state.held,
          lastResult: state.lastResult,
          message: { text: shown, style: "muted" as const },
        }),
      },
    };
  };

  const submit = async (payload: Record<string, unknown>): Promise<HandlerResponse> => {
    const conversation = conversationFrom(payload, config.settings);
    if (!conversation.id) return { status: 400, body: { error: "no conversation" } };
    const admin = (payload.admin ?? {}) as Record<string, unknown>;
    const actor = typeof admin.email === "string" ? admin.email : null;
    const state = await load(conversation.id);
    const input = (payload.input_values ?? {}) as Record<string, unknown>;
    const form = formFrom(input);

    // A held capture first: the reply already went out, only the reason is missing.
    // The form re-sends nothing but the reason; the held body is what gets posted.
    if (state.held) {
      const reasonCode = form.reasonCode ?? state.held.body.reasonCode ?? null;
      const reason = form.note.trim() || state.held.body.reason || "";
      if (state.held.changed && !reasonCode) {
        return {
          status: 200,
          body: {
            canvas: captureCanvas({
              draft: state.draft,
              form,
              settings: config.settings,
              held: state.held,
              message: {
                text: "Pick why you changed the reply - one click - to save this capture.",
                style: "error",
              },
            }),
          },
        };
      }
      const body: CaptureCreate = {
        ...state.held.body,
        reasonCode: state.held.changed ? reasonCode : null,
        reason: reason || null,
      };
      try {
        const r = await deps.postCapture(body);
        const done: ConversationState = {
          ...state,
          draft: null,
          draftFields: {},
          reasonCode: null,
          note: "",
          held: null,
          lastResult: { kind: r.kind, changed: r.changed, dedup: r.deduplicated },
          message: "",
          capturedPartIds:
            state.held.partId && !state.capturedPartIds.includes(state.held.partId)
              ? [...state.capturedPartIds, state.held.partId]
              : state.capturedPartIds,
        };
        await store.set(conversation.id, done);
        return {
          status: 200,
          body: {
            canvas: captureCanvas({
              draft: null,
              form: EMPTY_FORM,
              settings: config.settings,
              lastResult: done.lastResult,
            }),
          },
        };
      } catch {
        // The failure is kept, not dropped: the panel still holds the capture to retry.
        state.message = "Overturn could not save this correction (network).";
        await store.set(conversation.id, state);
        return {
          status: 200,
          body: {
            canvas: captureCanvas({
              draft: state.draft,
              form,
              settings: config.settings,
              held: state.held,
              message: { text: state.message, style: "error" },
            }),
          },
        };
      }
    }

    const recorded = await deps.findRecordedDraft(conversation.id);
    // The form states the origin when the teammate picked one; when it states none, the
    // draft we already hold (or the recorded run) is the one that knows where it came from.
    const explicitOrigin =
      typeof input.draft_origin === "string" && input.draft_origin.trim()
        ? draftOriginFrom(input.draft_origin)
        : null;
    const pasted = form.draftText.trim()
      ? acceptDraft(
          form.draftText,
          explicitOrigin ?? state.draft?.origin ?? recorded?.origin ?? "unknown",
          config.settings,
          Date.now(),
        )
      : null;
    const draft: DraftState | null =
      pasted ??
      state.draft ??
      (recorded ? acceptDraft(recorded.text, recorded.origin, config.settings, recorded.at) : null);
    if (draft) {
      state.draft = {
        ...draft,
        runId: draft.runId ?? recorded?.runId ?? state.draft?.runId,
        model: draft.model ?? recorded?.model ?? state.draft?.model ?? null,
      };
      state.draftFields = conversation.fields;
      state.reasonCode = form.reasonCode ?? state.reasonCode;
      state.note = form.note || state.note;
      state.lastResult = null;
    }
    const decision = decideOnSend({
      conversation,
      draft,
      draftFields: state.draftFields,
      send: { text: form.sentText, type: "publicReply", fields: conversation.fields },
      reasonCode: form.reasonCode,
      reason: form.note,
      actor,
      settings: config.settings,
      now: Date.now(),
    });
    if (decision.action === "need-reason") {
      await store.set(conversation.id, state);
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
      await store.set(conversation.id, state);
      return {
        status: 200,
        body: {
          canvas: captureCanvas({
            draft,
            form,
            settings: config.settings,
            message: {
              text: SKIP_MESSAGES[decision.why] ?? "Nothing to capture from that submission.",
              style: "muted",
            },
          }),
        },
      };
    }
    try {
      const r = await deps.postCapture(decision.body);
      const done: ConversationState = {
        ...state,
        draft: null,
        draftFields: {},
        reasonCode: null,
        note: "",
        held: null,
        lastResult: { kind: r.kind, changed: r.changed, dedup: r.deduplicated },
        message: "",
      };
      await store.set(conversation.id, done);
      return {
        status: 200,
        body: {
          canvas: captureCanvas({
            draft: null,
            form: EMPTY_FORM,
            settings: config.settings,
            lastResult: done.lastResult,
          }),
        },
      };
    } catch {
      // The form says what happened; a failed capture changes nothing in Intercom.
      state.message = "Overturn could not save this correction (network).";
      await store.set(conversation.id, state);
      return {
        status: 200,
        body: {
          canvas: captureCanvas({
            draft,
            form,
            settings: config.settings,
            message: { text: state.message, style: "error" },
          }),
        },
      };
    }
  };

  /**
   * `conversation.admin.replied` / `conversation.admin.noted`: the reply that went out.
   * Always acknowledged 200 - a failed capture is held for the panel, never retried into
   * a storm - and never read for a conversation that never had a draft. A redelivery of
   * an event already captured is answered as a duplicate, not captured twice.
   */
  const webhook = async (payload: Record<string, unknown>): Promise<HandlerResponse> => {
    try {
      const topic = typeof payload.topic === "string" ? payload.topic : "";
      const type =
        topic === "conversation.admin.replied"
          ? "reply"
          : topic === "conversation.admin.noted"
            ? "note"
            : null;
      if (!type) return { status: 200, body: { ok: true, ignored: topic || null } };
      if (type === "note" && !config.settings.captureInternalNotes) {
        return { status: 200, body: { ok: true, skipped: "internal-note" } };
      }
      const item = ((payload.data ?? {}) as Record<string, unknown>).item as
        | Record<string, unknown>
        | undefined;
      if (!item || typeof item !== "object") return { status: 200, body: { ok: true, ignored: topic } };
      const id = String(item.id ?? "");
      if (!id) return { status: 200, body: { ok: true, ignored: topic } };
      const parts = webhookParts(item);
      // The reply that went out: the newest human-admin comment (or note). Fin and bot
      // replies arrive on admin.replied too, so only author.type admin counts as the
      // human send; a bot reply is never the teammate's sent text.
      const sentPart = [...parts].reverse().find((p) => {
        const author = partAuthor(p);
        const partType = typeof p.part_type === "string" ? p.part_type : "";
        const body = typeof p.body === "string" ? p.body : "";
        return (
          author.type === "admin" &&
          body.trim() &&
          (type === "reply" ? partType === "comment" : partType === "note")
        );
      });
      if (!sentPart || typeof sentPart.body !== "string") {
        return { status: 200, body: { ok: true, skipped: "no-part" } };
      }
      const state = await load(id);
      const sentId = typeof sentPart.id === "string" ? sentPart.id : null;
      // A redelivery of an event already captured posts nothing twice.
      if (sentId && state.capturedPartIds.includes(sentId)) {
        return { status: 200, body: { ok: true, skipped: "duplicate" } };
      }
      await storeRecordedDraft(
        id,
        state,
        fieldsFrom((item.custom_attributes ?? null) as Record<string, unknown> | null, config.settings),
      );
      if (!state.draft) return { status: 200, body: { ok: true, skipped: "no-draft" } };
      const snapshot = conversationFromWebhook(item, config.settings, sentId);
      const sentAuthor = partAuthor(sentPart);
      const decision = decideOnSend({
        conversation: snapshot,
        draft: state.draft,
        draftFields: state.draftFields,
        send: {
          text: sentPart.body,
          type: type === "note" ? "internalNote" : "publicReply",
          fields: snapshot.fields,
        },
        reasonCode: state.reasonCode,
        reason: state.note,
        actor: sentAuthor.email ?? sentAuthor.name ?? null,
        settings: config.settings,
        now: Date.now(),
      });
      if (decision.action === "skip") return { status: 200, body: { ok: true, skipped: decision.why } };
      if (decision.action === "need-reason") {
        // Hold the body built with require_reason off, so the panel can post it as soon
        // as a reason is picked; the send itself already happened and is never held.
        const open = decideOnSend({
          conversation: snapshot,
          draft: state.draft,
          draftFields: state.draftFields,
          send: {
            text: sentPart.body,
            type: type === "note" ? "internalNote" : "publicReply",
            fields: snapshot.fields,
          },
          reasonCode: null,
          reason: state.note,
          actor: sentAuthor.email ?? sentAuthor.name ?? null,
          settings: { ...config.settings, requireReason: false },
          now: Date.now(),
        });
        if (open.action === "capture") {
          state.held = {
            body: open.body,
            changed: open.changed,
            changedFields: decision.changedFields,
            partId: sentId,
          };
          state.message = "";
          await store.set(id, state);
          return { status: 200, body: { ok: true, held: true } };
        }
        return { status: 200, body: { ok: true, held: false } };
      }
      try {
        const r = await deps.postCapture(decision.body);
        await store.set(id, {
          ...state,
          draft: null,
          draftFields: {},
          reasonCode: null,
          note: "",
          held: null,
          lastResult: { kind: r.kind, changed: r.changed, dedup: r.deduplicated },
          message: "",
          capturedPartIds:
            sentId && !state.capturedPartIds.includes(sentId)
              ? [...state.capturedPartIds, sentId]
              : state.capturedPartIds,
        });
        return { status: 200, body: { ok: true, captured: true } };
      } catch {
        // Keep the capture held so the panel can retry it; the reply already went out.
        state.held = {
          body: decision.body,
          changed: decision.changed,
          changedFields: decision.changedFields,
          partId: sentId,
        };
        state.message = "Overturn could not save this correction (network).";
        await store.set(id, state);
        return { status: 200, body: { ok: true, captured: false } };
      }
    } catch {
      return { status: 200, body: { ok: false } };
    }
  };

  return async (req: HandlerRequest): Promise<HandlerResponse> => {
    if (req.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
    if (req.path.endsWith("/webhook")) {
      if (!validWebhookSignature(req.rawBody, req.hubSignature, config.clientSecret)) {
        return { status: 401, body: { error: "bad signature" } };
      }
    } else if (!validSignature(req.rawBody, req.signature, config.clientSecret)) {
      return { status: 401, body: { error: "bad signature" } };
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody) as Record<string, unknown>;
    } catch {
      return { status: 400, body: { error: "bad json" } };
    }
    if (req.path.endsWith("/webhook")) return webhook(payload);
    if (req.path.endsWith("/initialize")) return initialize(payload);
    if (req.path.endsWith("/submit")) return submit(payload);
    return { status: 404, body: { error: "not found" } };
  };
}
