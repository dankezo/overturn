import { captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import {
  acceptDraft,
  type ConversationSnapshot,
  contextFrom,
  DEFAULT_SETTINGS,
  decideOnSend,
  draftOriginFrom,
  draftTag,
  fieldsFrom,
  settingsFrom,
  statusLine,
} from "./capture";

const draftText =
  "Hi Sam, thanks for flagging this. Your export failed because the file passed the 200 MB limit. Split it into two parts and re-upload, or I can raise the limit on your workspace for 24 hours if you would rather keep it whole.";

const conversation: ConversationSnapshot = {
  id: "conv_77",
  subject: "Export keeps failing",
  customerName: "Sam",
  customerEmail: "sam@example.com",
  messages: [
    {
      id: "p1",
      body: "<p>The export fails every time.</p>",
      kind: "customer",
      authorEmail: "sam@example.com",
      createdAt: "2026-10-02T09:00:00Z",
    },
  ],
  url: "https://app.intercom.com/a/apps/_/inbox/inbox/admin/all/conversation/conv_77",
  fields: {},
};

describe("settings", () => {
  it("defaults to the support pack on this surface", () => {
    expect(settingsFrom({}).reasonPack).toBe("support");
    expect(settingsFrom({ reason_pack: "claims" }).reasonPack).toBe("claims");
  });

  it("parses decision fields as id:label pairs", () => {
    const s = settingsFrom({ decision_fields: "refund_status:status, tier" });
    expect(s.decisionFields).toEqual([
      { id: "refund_status", label: "status" },
      { id: "tier", label: "tier" },
    ]);
    expect(fieldsFrom({ refund_status: "issued", tier: "gold" }, s)).toEqual({
      status: "issued",
      tier: "gold",
    });
    expect(fieldsFrom({ refund_status: "issued" }, DEFAULT_SETTINGS)).toEqual({});
  });
});

describe("acceptDraft", () => {
  it("a short greeting is not a draft", () => {
    expect(acceptDraft("Hi Sam,", "ai", DEFAULT_SETTINGS, 1)).toBeNull();
    expect(acceptDraft(draftText, "ai", DEFAULT_SETTINGS, 1)?.origin).toBe("ai");
  });
});

describe("draft origin tagging", () => {
  it("anything not told to us is unknown, never guessed", () => {
    expect(draftOriginFrom("ai")).toBe("ai");
    expect(draftOriginFrom("manual")).toBe("manual");
    expect(draftOriginFrom(undefined)).toBe("unknown");
    expect(draftOriginFrom("fin")).toBe("unknown");
    expect(draftOriginFrom("")).toBe("unknown");
    expect(draftTag("unknown")).toBe("draft:unknown");
  });
});

describe("decideOnSend", () => {
  const base = {
    conversation,
    draftFields: {} as Record<string, unknown>,
    reasonCode: null as string | null,
    reason: "",
    actor: "lee@vendor.com",
    settings: DEFAULT_SETTINGS,
    now: 1_042_000,
  };
  const draftAt = 1_000_000;

  it("an untouched draft is an approve capture tagged with the told origin", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "ai", runId: "11111111-1111-4111-8111-111111111111", at: draftAt },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("intercom");
    expect(d.body.externalId).toBe("ic:conv_77");
    expect(d.body.tags).toEqual(["draft:ai", "public-reply"]);
    expect(d.body.draftRunId).toBe("11111111-1111-4111-8111-111111111111");
    expect(captureCreateSchema.safeParse(d.body).success).toBe(true);
  });

  it("an untold origin still tags the run: draft:unknown, not silence", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "unknown", at: draftAt },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error("expected capture");
    expect(d.body.tags).toEqual(["draft:unknown", "public-reply"]);
    expect(captureCreateSchema.safeParse(d.body).success).toBe(true);
  });

  it("a human-typed draft tags draft:manual", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "manual", at: draftAt },
      send: { text: `${draftText} Thanks again.`, type: "publicReply", fields: {} },
      reasonCode: "tone_wording",
    });
    if (d.action !== "capture") throw new Error("expected capture");
    expect(d.body.tags?.[0]).toBe("draft:manual");
    expect(d.body.reasonCode).toBe("tone_wording");
  });

  it("a changed reply with no reason is refused while require_reason is on", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "ai", at: draftAt },
      send: { text: "Split it into two parts and re-upload.", type: "publicReply", fields: {} },
    });
    expect(d).toEqual({ action: "need-reason", changedFields: [] });
  });

  it("skips: no draft, empty send, internal note by default, greeting-sized draft", () => {
    expect(
      decideOnSend({ ...base, draft: null, send: { text: "x", type: "publicReply", fields: {} } }),
    ).toEqual({
      action: "skip",
      why: "no-draft",
    });
    expect(
      decideOnSend({
        ...base,
        draft: { text: draftText, origin: "ai", at: draftAt },
        send: { text: " ", type: "publicReply", fields: {} },
      }),
    ).toEqual({ action: "skip", why: "empty" });
    expect(
      decideOnSend({
        ...base,
        draft: { text: draftText, origin: "ai", at: draftAt },
        send: { text: "internal", type: "internalNote", fields: {} },
      }),
    ).toEqual({ action: "skip", why: "internal-note" });
    expect(
      decideOnSend({
        ...base,
        draft: { text: "Hi there!", origin: "manual", at: draftAt },
        send: { text: "Hi there!", type: "publicReply", fields: {} },
      }),
    ).toEqual({ action: "skip", why: "draft-too-short" });
  });

  it("an already-prefixed conversation id is not prefixed twice", () => {
    const d = decideOnSend({
      ...base,
      conversation: { ...conversation, id: "ic:conv_77" },
      draft: { text: draftText, origin: "unknown", at: draftAt },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error("expected capture");
    expect(d.body.externalId).toBe("ic:conv_77");
  });
});

describe("statusLine", () => {
  it("waits, then counts words", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "ai", at: 0 }, null)).toBe("Draft inserted · 3 words");
  });

  it("counts the words a human reads, not the HTML tags around them", () => {
    expect(statusLine({ text: "<p>one two three</p>", origin: "ai", at: 0 }, null)).toBe(
      "Draft inserted · 3 words",
    );
  });
});

describe("decision fields", () => {
  const fieldSettings = {
    ...DEFAULT_SETTINGS,
    decisionFields: [{ id: "refund_status", label: "status" }],
  };
  const fieldBase = {
    conversation: { ...conversation, fields: { status: "issued" } },
    reasonCode: "wrong_answer" as string | null,
    reason: "",
    actor: "lee@vendor.com",
    settings: fieldSettings,
    now: 1_042_000,
  };

  it("a field change between draft and send is scored exactly", () => {
    const d = decideOnSend({
      ...fieldBase,
      draft: { text: draftText, origin: "ai", at: 1_000_000 },
      draftFields: { status: "pending" },
      send: { text: draftText, type: "publicReply", fields: { status: "issued" } },
    });
    if (d.action !== "capture") throw new Error("expected capture");
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.draft.fields).toEqual({ status: "pending" });
    expect(d.body.sent.fields).toEqual({ status: "issued" });
    expect(captureCreateSchema.safeParse(d.body).success).toBe(true);
  });

  it("without decision fields configured no fields are attached", () => {
    const d = decideOnSend({
      conversation,
      draftFields: { status: "pending" },
      draft: { text: draftText, origin: "ai", at: 1_000_000 },
      send: { text: draftText, type: "publicReply", fields: { status: "issued" } },
      reasonCode: null,
      reason: "",
      actor: "lee@vendor.com",
      settings: DEFAULT_SETTINGS,
      now: 1_042_000,
    });
    if (d.action !== "capture") throw new Error("expected capture");
    expect(d.changed).toBe(false);
    expect(d.body.draft.fields).toBeUndefined();
    expect(d.body.sent.fields).toBeUndefined();
  });
});

describe("context roles", () => {
  it("a Fin bot message is system, not the customer", () => {
    const ctx = contextFrom({
      ...conversation,
      messages: [
        ...conversation.messages,
        { id: "p2", body: "<p>Let me check that for you.</p>", kind: "bot", authorName: "Fin" },
      ],
    });
    expect(ctx).toHaveLength(2);
    expect(ctx[1]).toMatchObject({ role: "system", author: "Fin", content: "Let me check that for you." });
  });
});
