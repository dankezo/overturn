import { createHmac } from "node:crypto";
import { type CaptureResult, captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type DraftState } from "./capture";
import { createHandler, type Deps, validSignature } from "./server";

const SECRET = "test-secret";
const sign = (raw: string) => createHmac("sha256", SECRET).update(raw).digest("hex");

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
    const { d } = deps({ text: draftText, origin: "ai", runId: "run_9", at: 5 });
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
