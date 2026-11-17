import { createHmac } from "node:crypto";
import { type CaptureResult, captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type DraftState } from "./capture";
import { createHandler, type Deps, validSignature, validWebhookSignature } from "./server";

const SECRET = "test-secret";
const sign = (raw: string) => createHmac("sha256", SECRET).update(raw).digest("hex");
const signHook = (raw: string) => `sha1=${createHmac("sha1", SECRET).update(raw).digest("hex")}`;

const draftText =
  "Hi Sam, thanks for flagging this. Your export failed because the file passed the 200 MB limit. Split it into two parts and re-upload, or I can raise the limit on your workspace for 24 hours if you would rather keep it whole.";

function payload(extra: Record<string, unknown>): string {
  return JSON.stringify({
    context: {
      conversation: {
        id: "conv_77",
        title: "Export keeps failing",
        parts: [
          {
            id: "p1",
            body: "<p>The export fails every time.</p>",
            part_type: "comment",
            author_type: "user",
            author_email: "sam@example.com",
            created_at: "2026-10-02T09:00:00Z",
          },
        ],
      },
    },
    admin: { email: "lee@vendor.com" },
    ...extra,
  });
}

function deps(recorded: DraftState | null) {
  const postCapture = vi.fn(
    async (_body: unknown): Promise<CaptureResult> =>
      ({
        runId: "run_new",
        kind: "edit",
        changed: true,
        deduplicated: false,
      }) as unknown as CaptureResult,
  );
  const d: Deps = {
    config: { clientSecret: SECRET, apiKey: "key", settings: DEFAULT_SETTINGS },
    findRecordedDraft: async () => recorded,
    postCapture,
  };
  return { d, postCapture };
}

describe("validSignature", () => {
  it("accepts the HMAC of the raw body and nothing else", () => {
    const raw = payload({});
    expect(validSignature(raw, sign(raw), SECRET)).toBe(true);
    expect(validSignature(raw, sign(`${raw} `), SECRET)).toBe(false);
    expect(validSignature(raw, undefined, SECRET)).toBe(false);
    expect(validSignature(raw, sign(raw), "")).toBe(false);
  });
});

describe("handler", () => {
  it("rejects an unsigned or badly signed call before touching anything", async () => {
    const { d, postCapture } = deps(null);
    const handle = createHandler(d);
    const raw = payload({});
    expect((await handle({ method: "POST", path: "/initialize", rawBody: raw })).status).toBe(401);
    expect(
      (await handle({ method: "POST", path: "/initialize", rawBody: raw, signature: "00" })).status,
    ).toBe(401);
    expect(postCapture).not.toHaveBeenCalled();
  });

  it("initialize with no draft renders only the waiting line", async () => {
    const { d } = deps(null);
    const handle = createHandler(d);
    const raw = payload({});
    const out = await handle({ method: "POST", path: "/initialize", rawBody: raw, signature: sign(raw) });
    expect(out.status).toBe(200);
    const body = out.body as { canvas: { content: { components: unknown[] } } };
    expect(body.canvas.content.components).toHaveLength(1);
  });

  it("initialize with a recorded run prefills the form and marks the origin ai", async () => {
    const { d } = deps({
      text: draftText,
      origin: "ai",
      runId: "0199a0d0-0000-7000-8000-000000000000",
      at: Date.now() - 4000,
    });
    const handle = createHandler(d);
    const raw = payload({});
    const out = await handle({ method: "POST", path: "/initialize", rawBody: raw, signature: sign(raw) });
    const body = out.body as {
      canvas: { content: { components: Array<{ id: string; value?: string }> } };
    };
    const draftField = body.canvas.content.components.find((c) => c.id === "draft_text");
    const origin = body.canvas.content.components.find((c) => c.id === "draft_origin");
    expect(draftField?.value).toBe(draftText);
    expect(origin?.value).toBe("ai");
  });

  it("submit of a changed reply with no reason re-renders with an error and posts nothing", async () => {
    const { d, postCapture } = deps(null);
    const handle = createHandler(d);
    const raw = payload({
      input_values: {
        draft_text: draftText,
        sent_text: "Split it into two parts and re-upload.",
        draft_origin: "ai",
        reason_code: "",
        reason_note: "",
      },
    });
    const out = await handle({ method: "POST", path: "/submit", rawBody: raw, signature: sign(raw) });
    expect(out.status).toBe(200);
    expect(postCapture).not.toHaveBeenCalled();
    const body = out.body as {
      canvas: { content: { components: Array<{ id: string; style?: string }> } };
    };
    expect(body.canvas.content.components.find((c) => c.id === "message")?.style).toBe("error");
  });

  it("submit posts a contract-valid capture, tagged draft:unknown when the origin was not told", async () => {
    const { d, postCapture } = deps(null);
    const handle = createHandler(d);
    const raw = payload({
      input_values: {
        draft_text: draftText,
        sent_text: draftText,
        draft_origin: "",
        reason_code: "",
        reason_note: "",
      },
    });
    const out = await handle({ method: "POST", path: "/submit", rawBody: raw, signature: sign(raw) });
    expect(out.status).toBe(200);
    expect(postCapture).toHaveBeenCalledTimes(1);
    const posted = postCapture.mock.calls[0]?.[0] as {
      source: string;
      externalId: string;
      tags: string[];
      actor: string | null;
    };
    expect(posted.source).toBe("intercom");
    expect(posted.externalId).toBe("ic:conv_77");
    expect(posted.tags).toEqual(["draft:unknown", "public-reply"]);
    expect(posted.actor).toBe("lee@vendor.com");
    expect(captureCreateSchema.safeParse(posted).success).toBe(true);
  });
});

describe("validWebhookSignature", () => {
  it("accepts sha1=<hex HMAC-SHA1> and nothing else", () => {
    const raw = JSON.stringify({ topic: "conversation.admin.replied" });
    expect(validWebhookSignature(raw, signHook(raw), SECRET)).toBe(true);
    expect(validWebhookSignature(raw, sign(raw), SECRET)).toBe(false);
    expect(validWebhookSignature(raw, undefined, SECRET)).toBe(false);
    expect(validWebhookSignature(raw, signHook(raw), "")).toBe(false);
  });
});

/** A conversation.admin.* delivery carrying one teammate reply. */
function replyHook(
  sentText: string,
  opts: { topic?: string; authorType?: string; partType?: string; partId?: string } = {},
): string {
  return JSON.stringify({
    topic: opts.topic ?? "conversation.admin.replied",
    data: {
      item: {
        id: "conv_77",
        title: "Export keeps failing",
        source: {
          id: "s1",
          part_type: "comment",
          body: "<p>The export fails every time.</p>",
          author: { type: "user", email: "sam@example.com" },
          created_at: 1759312800,
        },
        conversation_parts: {
          conversation_parts: [
            {
              id: opts.partId ?? "p9",
              part_type: opts.partType ?? "comment",
              body: `<p>${sentText}</p>`,
              author: { type: opts.authorType ?? "admin", email: "lee@vendor.com" },
              created_at: 1759312900,
            },
          ],
        },
        contacts: { contacts: [{ email: "sam@example.com", name: "Sam" }] },
        custom_attributes: {},
      },
    },
  });
}

const canvasComponents = (out: { body: unknown }) =>
  (out.body as { canvas: { content: { components: Array<{ id?: string; text?: string; value?: string }> } } })
    .canvas.content.components;

describe("webhook", () => {
  it("rejects an unsigned webhook before touching anything", async () => {
    const { d, postCapture } = deps({
      text: draftText,
      origin: "ai",
      runId: "0199a0d0-0000-7000-8000-000000000000",
      at: Date.now() - 4000,
    });
    const handle = createHandler(d);
    const raw = replyHook(draftText);
    expect((await handle({ method: "POST", path: "/webhook", rawBody: raw })).status).toBe(401);
    expect(
      (await handle({ method: "POST", path: "/webhook", rawBody: raw, hubSignature: "sha1=00" })).status,
    ).toBe(401);
    expect(postCapture).not.toHaveBeenCalled();
  });

  it("a conversation with no draft is never captured, whatever the reply says", async () => {
    const { d, postCapture } = deps(null);
    const handle = createHandler(d);
    const raw = replyHook(draftText);
    const out = await handle({ method: "POST", path: "/webhook", rawBody: raw, hubSignature: signHook(raw) });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, skipped: "no-draft" });
    expect(postCapture).not.toHaveBeenCalled();
  });

  it("an unchanged reply that actually went out is captured with the real sent text", async () => {
    const { d, postCapture } = deps({
      text: draftText,
      origin: "ai",
      runId: "0199a0d0-0000-7000-8000-000000000000",
      at: Date.now() - 4000,
    });
    const handle = createHandler(d);
    const initRaw = payload({});
    await handle({ method: "POST", path: "/initialize", rawBody: initRaw, signature: sign(initRaw) });
    const raw = replyHook(draftText);
    const out = await handle({ method: "POST", path: "/webhook", rawBody: raw, hubSignature: signHook(raw) });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true, captured: true });
    expect(postCapture).toHaveBeenCalledTimes(1);
    const posted = postCapture.mock.calls[0]?.[0] as {
      source: string;
      externalId: string;
      tags: string[];
      actor: string | null;
      sent: { text: string };
      context: Array<{ content: string }>;
    };
    expect(posted.source).toBe("intercom");
    expect(posted.externalId).toBe("ic:conv_77");
    expect(posted.tags).toEqual(["draft:ai", "public-reply"]);
    expect(posted.actor).toBe("lee@vendor.com");
    expect(posted.sent.text).toBe(draftText);
    // The context is the thread before the reply: the sent part is not in it twice.
    expect(posted.context).toHaveLength(1);
    expect(posted.context[0]?.content).toBe("The export fails every time.");
    expect(captureCreateSchema.safeParse(posted).success).toBe(true);
  });

  it("a redelivery of the same reply is a duplicate, not a second capture", async () => {
    const { d, postCapture } = deps({
      text: draftText,
      origin: "ai",
      runId: "0199a0d0-0000-7000-8000-000000000000",
      at: Date.now() - 4000,
    });
    const handle = createHandler(d);
    const initRaw = payload({});
    await handle({ method: "POST", path: "/initialize", rawBody: initRaw, signature: sign(initRaw) });
    const raw = replyHook(draftText);
    const hook = { method: "POST", path: "/webhook", rawBody: raw, hubSignature: signHook(raw) };
    expect((await handle(hook)).body).toEqual({ ok: true, captured: true });
    expect((await handle(hook)).body).toEqual({ ok: true, skipped: "duplicate" });
    expect(postCapture).toHaveBeenCalledTimes(1);
  });

  it("a changed reply is held until a reason is picked, then the held body posts", async () => {
    const { d, postCapture } = deps({
      text: draftText,
      origin: "ai",
      runId: "0199a0d0-0000-7000-8000-000000000000",
      at: Date.now() - 4000,
    });
    const handle = createHandler(d);
    const initRaw = payload({});
    await handle({ method: "POST", path: "/initialize", rawBody: initRaw, signature: sign(initRaw) });
    const changed = "Split it into two parts and re-upload.";
    const raw = replyHook(changed);
    const out = await handle({ method: "POST", path: "/webhook", rawBody: raw, hubSignature: signHook(raw) });
    expect(out.body).toEqual({ ok: true, held: true });
    expect(postCapture).not.toHaveBeenCalled();
    // The panel now asks for just the reason: the reply already went out.
    const panelRaw = payload({});
    const panel = await handle({
      method: "POST",
      path: "/initialize",
      rawBody: panelRaw,
      signature: sign(panelRaw),
    });
    const components = canvasComponents(panel);
    expect(components[0]?.text).toBe("Pick why you changed the reply");
    expect(components.some((c) => c.id === "draft_text")).toBe(false);
    expect(components.some((c) => c.id === "reason_code")).toBe(true);
    // Saving the reason posts the held body, with the real sent text, not the form's.
    const saveRaw = payload({
      input_values: {
        draft_text: "",
        sent_text: "",
        draft_origin: "",
        reason_code: "tone_wording",
        reason_note: "",
      },
    });
    const saved = await handle({
      method: "POST",
      path: "/submit",
      rawBody: saveRaw,
      signature: sign(saveRaw),
    });
    expect(saved.status).toBe(200);
    expect(postCapture).toHaveBeenCalledTimes(1);
    const posted = postCapture.mock.calls[0]?.[0] as {
      sent: { text: string };
      reasonCode: string | null;
      tags: string[];
    };
    expect(posted.sent.text).toBe(changed);
    expect(posted.reasonCode).toBe("tone_wording");
    expect(posted.tags).toEqual(["draft:ai", "public-reply"]);
    expect(captureCreateSchema.safeParse(posted).success).toBe(true);
  });

  it("a Fin bot reply on admin.replied is never the teammate's send", async () => {
    const { d, postCapture } = deps({
      text: draftText,
      origin: "ai",
      runId: "0199a0d0-0000-7000-8000-000000000000",
      at: Date.now() - 4000,
    });
    const handle = createHandler(d);
    const initRaw = payload({});
    await handle({ method: "POST", path: "/initialize", rawBody: initRaw, signature: sign(initRaw) });
    const raw = replyHook(draftText, { authorType: "bot" });
    const out = await handle({ method: "POST", path: "/webhook", rawBody: raw, hubSignature: signHook(raw) });
    expect(out.body).toEqual({ ok: true, skipped: "no-part" });
    expect(postCapture).not.toHaveBeenCalled();
  });

  it("an internal note is skipped unless capture_internal_notes is on", async () => {
    const noted = (captureInternalNotes: boolean) => {
      const postCapture = vi.fn(
        async (_body: unknown): Promise<CaptureResult> =>
          ({
            runId: "run_new",
            kind: "edit",
            changed: true,
            deduplicated: false,
          }) as unknown as CaptureResult,
      );
      const d: Deps = {
        config: {
          clientSecret: SECRET,
          apiKey: "key",
          settings: { ...DEFAULT_SETTINGS, captureInternalNotes },
        },
        findRecordedDraft: async () => ({
          text: draftText,
          origin: "ai",
          runId: "0199a0d0-0000-7000-8000-000000000000",
          at: Date.now() - 4000,
        }),
        postCapture,
      };
      return { d, postCapture };
    };
    const off = noted(false);
    const handleOff = createHandler(off.d);
    const initRaw = payload({});
    await handleOff({ method: "POST", path: "/initialize", rawBody: initRaw, signature: sign(initRaw) });
    const noteRaw = replyHook("Internal: refund approved.", {
      topic: "conversation.admin.noted",
      partType: "note",
    });
    expect(
      (
        await handleOff({
          method: "POST",
          path: "/webhook",
          rawBody: noteRaw,
          hubSignature: signHook(noteRaw),
        })
      ).body,
    ).toEqual({ ok: true, skipped: "internal-note" });
    expect(off.postCapture).not.toHaveBeenCalled();

    const on = noted(true);
    const handleOn = createHandler(on.d);
    await handleOn({ method: "POST", path: "/initialize", rawBody: initRaw, signature: sign(initRaw) });
    const noteSameRaw = replyHook(draftText, { topic: "conversation.admin.noted", partType: "note" });
    const out = await handleOn({
      method: "POST",
      path: "/webhook",
      rawBody: noteSameRaw,
      hubSignature: signHook(noteSameRaw),
    });
    expect(out.body).toEqual({ ok: true, captured: true });
    const posted = on.postCapture.mock.calls[0]?.[0] as { tags: string[] };
    expect(posted.tags).toEqual(["draft:ai", "internal-note"]);
  });

  it("a failed webhook capture stays held so the panel can retry it", async () => {
    const postCapture = vi.fn(
      async (_body: unknown): Promise<CaptureResult> =>
        ({ runId: "run_new", kind: "edit", changed: true, deduplicated: false }) as unknown as CaptureResult,
    );
    // The webhook's first post fails; the retry from the panel succeeds.
    postCapture.mockImplementationOnce(async (_body: unknown): Promise<CaptureResult> => {
      throw new Error("down");
    });
    const d: Deps = {
      config: {
        clientSecret: SECRET,
        apiKey: "key",
        settings: { ...DEFAULT_SETTINGS, requireReason: false },
      },
      findRecordedDraft: async () => ({
        text: draftText,
        origin: "ai",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        at: Date.now() - 4000,
      }),
      postCapture,
    };
    const handle = createHandler(d);
    const initRaw = payload({});
    await handle({ method: "POST", path: "/initialize", rawBody: initRaw, signature: sign(initRaw) });
    const raw = replyHook(draftText);
    const out = await handle({ method: "POST", path: "/webhook", rawBody: raw, hubSignature: signHook(raw) });
    expect(out.body).toEqual({ ok: true, captured: false });
    const saveRaw = payload({
      input_values: { draft_text: "", sent_text: "", draft_origin: "", reason_code: "", reason_note: "" },
    });
    const saved = await handle({
      method: "POST",
      path: "/submit",
      rawBody: saveRaw,
      signature: sign(saveRaw),
    });
    expect(saved.status).toBe(200);
    expect(postCapture).toHaveBeenCalledTimes(2);
  });

  it("submit with no origin stated keeps the recorded run's ai origin", async () => {
    const { d, postCapture } = deps({
      text: draftText,
      origin: "ai",
      runId: "0199a0d0-0000-7000-8000-000000000000",
      at: Date.now() - 4000,
    });
    const handle = createHandler(d);
    const raw = payload({
      input_values: {
        draft_text: draftText,
        sent_text: draftText,
        draft_origin: "",
        reason_code: "",
        reason_note: "",
      },
    });
    const out = await handle({ method: "POST", path: "/submit", rawBody: raw, signature: sign(raw) });
    expect(out.status).toBe(200);
    expect(postCapture).toHaveBeenCalledTimes(1);
    const posted = postCapture.mock.calls[0]?.[0] as { tags: string[] };
    expect(posted.tags).toEqual(["draft:ai", "public-reply"]);
  });
});
