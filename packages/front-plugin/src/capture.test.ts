import { captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import {
  type ConversationSnapshot,
  contextFrom,
  createDraftDetector,
  createPendingCapture,
  DEFAULT_SETTINGS,
  decideOnSend,
  inScope,
  quickReasons,
  type SendDecision,
  sentFromMessages,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const conversation: ConversationSnapshot = {
  id: "cnv_123",
  subject: "Roof leak after storm",
  recipientName: "Dana",
  recipientEmail: "dana@example.com",
  messages: [
    {
      id: "msg_1",
      body: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      kind: "inbound",
      authorEmail: "dana@example.com",
      createdAt: "2026-10-01T10:00:00Z",
    },
    { id: "msg_2", body: "HO-3, no prior claims.", kind: "note", authorName: "Ray" },
  ],
  customFields: {},
  url: "https://app.frontapp.com/open/cnv_123",
};

describe("settings", () => {
  it("parses the plugin configuration", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "claims-reply",
      require_reason: "true",
      decision_fields: "status:status, total:total,reserve",
      min_draft_chars: "120",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "status", label: "status" },
      { id: "total", label: "total" },
      { id: "reserve", label: "reserve" },
    ]);
    expect(s.minDraftChars).toBe(120);
  });

  it("a scope tag limits which conversations are watched at all", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("the claims pack is this surface's default; the support pack is a setting away", () => {
    const codes = quickReasons(DEFAULT_SETTINGS).map((r) => r.code);
    expect(codes).toContain("wrong_coverage_decision");
    expect(codes).toContain("reserve_too_low");
    expect(codes).toHaveLength(8);
    expect(settingsFrom({}).reasonPack).toBe("claims");
    const support = settingsFrom({ reason_pack: "support" });
    expect(support.reasonPack).toBe("support");
    expect(quickReasons(support).map((r) => r.code)).toContain("wrong_answer");
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
  });

  it("the default workflow follows the reason pack", () => {
    expect(settingsFrom({}).agent).toBe("claims-reply");
    expect(settingsFrom({ agent: "support-reply" }).agent).toBe("support-reply");
    expect(settingsFrom({ reason_pack: "support" }).agent).toBe("support-reply");
    expect(settingsFrom({ reason_pack: "support", agent: "claims-reply" }).agent).toBe("claims-reply");
  });

  it("falls back to defaults, with require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ require_reason: "false" }).requireReason).toBe(false);
  });

  it("boolean settings read case-insensitively, so TRUE means on", () => {
    expect(settingsFrom({ require_reason: "True" }).requireReason).toBe(true);
    expect(settingsFrom({ require_reason: "TRUE" }).requireReason).toBe(true);
    expect(settingsFrom({ require_reason: "FALSE" }).requireReason).toBe(false);
    expect(settingsFrom({ capture_internal_notes: "True" }).captureInternalNotes).toBe(true);
  });

  it("decision fields with no id are dropped instead of becoming an empty field", () => {
    expect(settingsFrom({ decision_fields: "status:status, :,reserve" }).decisionFields).toEqual([
      { id: "status", label: "status" },
      { id: "reserve", label: "reserve" },
    ]);
  });
});

describe("draft detection", () => {
  const long = "x".repeat(200);
  it("a reply-sized insert into an empty composer is the draft; typing is not", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 100; i++) {
      text += "ab";
      expect(d.onComposer(text, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();
    const d2 = createDraftDetector({ minDraftChars: 80 });
    d2.onComposer("", 0);
    expect(d2.onComposer(long, 500)?.origin).toBe("inserted");
    expect(d2.onComposer(`${long} more`, 600)).toBeNull(); // only the first
  });
  it("a composer that already holds a reply on load is a preloaded draft", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer(long, 10)?.origin).toBe("preloaded");
  });
  it("a paste after a pause while a short greeting was typed still counts", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    d.onComposer("Hi Dana,", 1000);
    expect(d.onComposer(`Hi Dana,\n${long}`, 9000)?.origin).toBe("inserted");
  });
});

describe("context and html", () => {
  it("strips html and maps roles", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-10-01T10:00:00Z",
      },
      { role: "note", author: "Ray", content: "HO-3, no prior claims.", at: null },
    ]);
  });

  it("drops style and script blocks and the apos entity instead of leaking them as text", () => {
    expect(stripHtml("<style>.x{color:red}</style><p>hi</p>")).toBe("hi");
    expect(stripHtml("<script>var x = 1;</script><p>hi</p>")).toBe("hi");
    expect(stripHtml("<p>it&apos;s fine</p>")).toBe("it's fine");
  });

  it("plain-text and markdown bodies keep their angle brackets; html is still stripped", () => {
    const mixed: ConversationSnapshot = {
      ...conversation,
      messages: [
        {
          id: "t1",
          body: "Covered when the loss is < $5,000 and > $0.",
          kind: "inbound",
          contentType: "text",
        },
        { id: "t2", body: "Check `List<T>` before the call.", kind: "note", contentType: "markdown" },
        { id: "t3", body: "<p>Covered when a < b.</p>", kind: "inbound", contentType: "html" },
      ],
    };
    expect(contextFrom(mixed).map((m) => m.content)).toEqual([
      "Covered when the loss is < $5,000 and > $0.",
      "Check `List<T>` before the call.",
      "Covered when a < b.",
    ]);
  });

  it("the message just sent is context for nobody: it is excluded, not duplicated as context", () => {
    expect(contextFrom(conversation, "msg_1")).toEqual([
      { role: "note", author: "Ray", content: "HO-3, no prior claims.", at: null },
    ]);
    expect(contextFrom(conversation, "msg_missing")).toHaveLength(2);
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "inserted" as const, at: 1_000_000 };
  const base = {
    conversation,
    draft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@carrier.com",
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
    now: 1_042_000,
  };

  it("skips without a draft, on internal notes, and on empty sends", () => {
    expect(
      decideOnSend({ ...base, draft: null, send: { text: "x", type: "publicReply", fields: {} } }),
    ).toEqual({ action: "skip", why: "no-draft" });
    expect(decideOnSend({ ...base, send: { text: "x", type: "internalNote", fields: {} } })).toEqual({
      action: "skip",
      why: "internal-note",
    });
    expect(decideOnSend({ ...base, send: { text: "<p></p>", type: "publicReply", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("sending the draft unchanged is an approve capture with the Front payload shape", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "publicReply", fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("front");
    expect(d.body.externalId).toBe("fr:cnv_123");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.tags).toEqual(["draft:inserted", "public-reply"]);
    expect(typeof d.body.secondsToSend).toBe("number");
    expect(d.body.context).toHaveLength(2);
    // The body the plugin posts must satisfy the shared capture contract.
    expect(captureCreateSchema.safeParse(d.body).success).toBe(true);
  });

  it("a sent reply in plain text keeps its angle brackets", () => {
    const d = decideOnSend({
      ...base,
      send: { text: "Covered when a < b.", contentType: "text", type: "publicReply", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.body.sent.text).toBe("Covered when a < b.");
    expect(captureCreateSchema.safeParse(d.body).success).toBe(true);
  });

  it("an already-prefixed conversation id is not prefixed twice", () => {
    const d = decideOnSend({
      ...base,
      conversation: { ...conversation, id: "fr:cnv_123" },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error("expected capture");
    expect(d.body.externalId).toBe("fr:cnv_123");
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const sent = draftText.replace("5 business days", "2 business days");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Storm SLA is 2 days",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Storm SLA is 2 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
    expect(d.body.sent.fields).toBeUndefined();
  });

  it("require_reason (the default) holds a changed send until a reason code is picked; a note alone is not enough", () => {
    const settings = DEFAULT_SETTINGS;
    const sent = draftText.replace("covered", "not covered");
    const blocked = decideOnSend({
      ...base,
      settings,
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });
    const noteOnly = decideOnSend({
      ...base,
      settings,
      reason: "exclusion",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(noteOnly.action).toBe("need-reason");
  });

  it("the capture context leaves out the message just sent", () => {
    const withSend = {
      ...conversation,
      messages: [...conversation.messages, { id: "msg_3", body: draftText, kind: "outbound" }],
    };
    const d = decideOnSend({
      ...base,
      conversation: withSend,
      send: { messageId: "msg_3", text: draftText, type: "publicReply", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.body.context).toHaveLength(2);
    expect(d.body.sent.text).toBe(d.body.draft.text);
    expect(d.body.context.every((m) => m.content !== d.body.sent.text)).toBe(true);
  });

  it("decision fields ride on both answers when configured", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      requireReason: false,
      decisionFields: [{ id: "status", label: "status" }],
    };
    const conv = { ...conversation, customFields: { status: "approved" } };
    const d = decideOnSend({
      ...base,
      conversation: conv,
      settings,
      draftFields: { status: "pending" },
      send: { text: draftText, type: "publicReply", fields: { status: "approved" } },
    });
    if (d.action !== "capture") throw new Error("expected capture");
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.draft.fields).toEqual({ status: "pending" });
    expect(d.body.sent.fields).toEqual({ status: "approved" });
  });
});

describe("sentFromMessages", () => {
  const msgs = conversation.messages;
  it("returns the first outbound message that was not already seen", () => {
    const seen = new Set(msgs.map((m) => m.id));
    const withSend = [...msgs, { id: "msg_3", body: "Sent text", kind: "outbound" }];
    expect(sentFromMessages(seen, withSend, DEFAULT_SETTINGS)).toEqual({
      messageId: "msg_3",
      text: "Sent text",
      type: "publicReply",
      fields: {},
    });
    expect(sentFromMessages(new Set(withSend.map((m) => m.id)), withSend, DEFAULT_SETTINGS)).toBeNull();
  });
  it("carries the message's declared content type through to the send", () => {
    const text = [{ id: "m1", body: "a < b", kind: "outbound", contentType: "text" as const }];
    expect(sentFromMessages(new Set(), text, DEFAULT_SETTINGS)).toEqual({
      messageId: "m1",
      text: "a < b",
      contentType: "text",
      type: "publicReply",
      fields: {},
    });
  });
  it("a draft armed from a recorded run does not turn an older outbound message into its send", () => {
    // The rule the panel upholds when a draft is armed: the thread as it stands at
    // arming time is baselined first, so only a message arriving after the draft
    // can read as its send.
    const thread = [...msgs, { id: "msg_old", body: "An earlier reply, sent days ago.", kind: "outbound" }];
    const baselined = new Set(thread.map((m) => m.id));
    expect(sentFromMessages(baselined, thread, DEFAULT_SETTINGS)).toBeNull();
    // The same thread with nothing baselined would misread the old reply as a send.
    expect(sentFromMessages(new Set(), thread, DEFAULT_SETTINGS)?.messageId).toBe("msg_old");
  });
  it("an inbound message is never a send, and a note is one only when notes are captured", () => {
    const inbound = [{ id: "m9", body: "customer reply", kind: "inbound" }];
    expect(sentFromMessages(new Set(), inbound, DEFAULT_SETTINGS)).toBeNull();
    const note = [{ id: "m8", body: "internal", kind: "note" }];
    expect(sentFromMessages(new Set(), note, DEFAULT_SETTINGS)).toBeNull();
    expect(sentFromMessages(new Set(), note, { ...DEFAULT_SETTINGS, captureInternalNotes: true })).toEqual({
      messageId: "m8",
      text: "internal",
      type: "internalNote",
      fields: {},
    });
  });
});

describe("pending capture (require_reason on a surface with no pre-send hook)", () => {
  it("holds only need-reason decisions and resolves by re-running the decision", () => {
    const pending = createPendingCapture();
    let calls = 0;
    const retry = (): SendDecision => {
      calls++;
      return decideOnSend({
        conversation,
        draft: { text: draftText, origin: "inserted", at: 1_000_000 },
        draftFields: {},
        send: { text: draftText, type: "publicReply", fields: {} },
        reasonCode: "tone_wording",
        reason: "",
        actor: null,
        settings: DEFAULT_SETTINGS,
        now: 1_042_000,
      });
    };
    expect(pending.hold({ action: "skip", why: "empty" }, retry)).toBe(false);
    expect(pending.pending()).toBe(false);
    expect(pending.hold({ action: "need-reason", changedFields: [] }, retry)).toBe(true);
    expect(pending.pending()).toBe(true);
    // Resolving runs the retry exactly once; the slot is then empty.
    expect(pending.resolve()?.action).toBe("capture");
    expect(calls).toBe(1);
    expect(pending.resolve()).toBeNull();
  });
});

describe("statusLine", () => {
  it("names the draft and its word count", () => {
    expect(statusLine({ text: "one two three", origin: "inserted", at: 0 }, null)).toBe(
      "Draft inserted · 3 words",
    );
    expect(statusLine(null, null)).toBe("Waiting for a draft");
  });
});
