import type {
  ApplicationComment,
  ApplicationCommentId,
  ApplicationConversationId,
  ApplicationCustomAttribute,
  ApplicationCustomFieldId,
  ApplicationDraft,
  ApplicationDraftId,
  ApplicationMessage,
  ApplicationMessageId,
  ApplicationPaginationToken,
  ApplicationSingleConversation,
  ApplicationTeammate,
  ApplicationTeammateId,
  EntryPointData,
  EntryPointTypesEnum,
} from "@frontapp/plugin-sdk";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, decideOnSend, sentFromMessages, settingsFrom } from "./capture";
import {
  type ConversationReader,
  type DraftReader,
  draftBodyFromReader,
  entryPointProperties,
  rawSettingsFrom,
  snapshotFromReader,
} from "./front";

const teammate: ApplicationTeammate = {
  id: "tm_ray" as ApplicationTeammateId,
  name: "Ray",
  username: "ray",
  email: "ray@carrier.com",
};

function conversationWith(
  overrides: Partial<ApplicationSingleConversation> = {},
): ApplicationSingleConversation {
  return {
    id: "cnv_123" as ApplicationConversationId,
    type: "email",
    status: "open",
    subject: "Roof leak after storm",
    blurb: undefined,
    assignee: undefined,
    recipient: { handle: "dana@example.com", name: "Dana", contact: undefined, type: "email" },
    channels: [],
    inboxes: [],
    tags: [],
    topics: [],
    links: [],
    closedAt: undefined,
    statusId: undefined,
    statusCategory: undefined,
    ticketIds: [],
    customFieldAttributes: [],
    draftId: undefined,
    ...overrides,
  };
}

function messageWith(overrides: Partial<ApplicationMessage> = {}): ApplicationMessage {
  return {
    id: "msg_1" as ApplicationMessageId,
    subject: undefined,
    date: new Date("2026-10-01T10:00:00Z"),
    status: "inbound",
    content: { body: "Water came through the ceiling.", type: "text", attachments: [] },
    rfc5322MessageId: undefined,
    from: { handle: "dana@example.com", name: "Dana", contact: undefined, type: "email" },
    replyTo: undefined,
    to: [],
    cc: undefined,
    bcc: undefined,
    ...overrides,
  };
}

function commentWith(overrides: Partial<ApplicationComment> = {}): ApplicationComment {
  return {
    id: "cmt_1" as ApplicationCommentId,
    author: teammate,
    content: { body: "HO-3, no prior claims.", attachments: [] },
    createdAt: new Date("2026-10-01T10:05:00Z"),
    ...overrides,
  };
}

function readerFor(
  conversation: ApplicationSingleConversation | undefined,
  messages: ApplicationMessage[],
  comments: ApplicationComment[] = [],
): ConversationReader {
  return {
    conversation,
    listMessages: async () => ({ results: messages, nextPageToken: undefined }),
    listComments: async () => ({ results: comments, nextPageToken: undefined }),
  };
}

const draftBody =
  "<p>Hi Dana,</p><p>Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

function draftWith(body: string): ApplicationDraft {
  return {
    id: "drf_1" as ApplicationDraftId,
    channel: {
      id: "chn_1" as ApplicationDraft["channel"]["id"],
      type: "email",
      inbox: {
        id: "inb_1" as ApplicationDraft["channel"]["inbox"]["id"],
        ownerId: teammate.id,
        name: "Claims",
        color: "#000000",
      },
      name: "Claims email",
      address: "claims@carrier.com",
    },
    to: [],
    cc: undefined,
    bcc: undefined,
    subject: undefined,
    content: { body, type: "html", attachments: [] },
    isEditable: true,
  };
}

describe("snapshotFromReader", () => {
  it("builds the snapshot from the listed messages, with comments merged in as notes, oldest first", async () => {
    const sent = messageWith({
      id: "msg_2" as ApplicationMessageId,
      status: "outbound",
      date: new Date("2026-10-01T10:10:00Z"),
      content: { body: draftBody, type: "html", attachments: [] },
      from: { handle: "ray@carrier.com", name: "Ray", contact: undefined, type: "email" },
    });
    const snap = await snapshotFromReader(
      readerFor(conversationWith(), [messageWith(), sent], [commentWith()]),
    );
    expect(snap).not.toBeNull();
    expect(snap!.id).toBe("cnv_123");
    expect(snap!.subject).toBe("Roof leak after storm");
    expect(snap!.recipientName).toBe("Dana");
    expect(snap!.recipientEmail).toBe("dana@example.com");
    expect(snap!.messages.map((m) => [m.id, m.kind])).toEqual([
      ["msg_1", "inbound"],
      ["cmt_1", "note"],
      ["msg_2", "outbound"],
    ]);
    expect(snap!.messages[2]!.authorEmail).toBe("ray@carrier.com");
    expect(snap!.messages[2]!.createdAt).toBe("2026-10-01T10:10:00.000Z");
  });

  it("a conversation whose listMessages returns a sent message produces a capture", async () => {
    const sent = messageWith({
      id: "msg_9" as ApplicationMessageId,
      status: "outbound",
      content: {
        body: draftBody.replace("5 business days", "2 business days"),
        type: "html",
        attachments: [],
      },
      from: { handle: "ray@carrier.com", name: "Ray", contact: undefined, type: "email" },
    });
    const snap = await snapshotFromReader(readerFor(conversationWith(), [messageWith(), sent]));
    expect(snap).not.toBeNull();
    const send = sentFromMessages(new Set(["msg_1"]), snap!.messages, DEFAULT_SETTINGS);
    expect(send?.type).toBe("publicReply");
    const decision = decideOnSend({
      conversation: snap!,
      draft: { text: draftBody, origin: "inserted", at: 1_000_000 },
      draftFields: {},
      send: send!,
      reasonCode: "wrong_amount_or_date",
      reason: "",
      actor: "ray@carrier.com",
      settings: DEFAULT_SETTINGS,
      now: 1_042_000,
    });
    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;
    expect(decision.changed).toBe(true);
    expect(decision.body.externalId).toBe("fr:cnv_123");
    expect(decision.body.sent.text).toContain("2 business days");
    expect(decision.body.tags).toEqual(["draft:inserted", "public-reply"]);
  });

  it("an internal comment listed through the context is a send only when notes are captured", async () => {
    const snap = await snapshotFromReader(readerFor(conversationWith(), [], [commentWith()]));
    expect(snap).not.toBeNull();
    expect(sentFromMessages(new Set(), snap!.messages, DEFAULT_SETTINGS)).toBeNull();
    const withNotes = { ...DEFAULT_SETTINGS, captureInternalNotes: true };
    expect(sentFromMessages(new Set(), snap!.messages, withNotes)).toEqual({
      text: "HO-3, no prior claims.",
      type: "internalNote",
      fields: {},
    });
  });

  it("follows the pagination token until the message list is exhausted", async () => {
    const reader: ConversationReader = {
      conversation: conversationWith(),
      listMessages: async (token) =>
        token
          ? {
              results: [messageWith({ id: "msg_2" as ApplicationMessageId, status: "outbound" })],
              nextPageToken: undefined,
            }
          : { results: [messageWith()], nextPageToken: "page_2" as ApplicationPaginationToken },
      listComments: async () => ({ results: [], nextPageToken: undefined }),
    };
    const snap = await snapshotFromReader(reader);
    expect(snap!.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
  });

  it("no conversation, no snapshot", async () => {
    expect(await snapshotFromReader(readerFor(undefined, []))).toBeNull();
  });
});

describe("custom field attributes", () => {
  const attributes: ApplicationCustomAttribute[] = [
    { id: "fld_status" as ApplicationCustomFieldId, name: "status", type: "string", value: "approved" },
    { id: "fld_total" as ApplicationCustomFieldId, name: "total", type: "number", value: 4200 },
  ];

  it("populate the snapshot's field map by field name", async () => {
    const snap = await snapshotFromReader(
      readerFor(conversationWith({ customFieldAttributes: attributes }), []),
    );
    expect(snap!.customFields).toEqual({ status: "approved", total: 4200 });
  });

  it("populate the decision fields a capture is diffed on", async () => {
    const snap = await snapshotFromReader(
      readerFor(conversationWith({ customFieldAttributes: attributes }), [messageWith()]),
    );
    const settings = {
      ...DEFAULT_SETTINGS,
      requireReason: false,
      decisionFields: [{ id: "status", label: "status" }],
    };
    // The send-side fields are read off the snapshot the way the panel reads them.
    const sendFields = Object.fromEntries(
      settings.decisionFields.map((f) => [f.label, snap!.customFields[f.id] ?? null]),
    );
    const decision = decideOnSend({
      conversation: snap!,
      draft: { text: draftBody, origin: "inserted", at: 1_000_000 },
      draftFields: { status: "pending" },
      send: { text: draftBody, type: "publicReply", fields: sendFields },
      reasonCode: null,
      reason: "",
      actor: "ray@carrier.com",
      settings,
      now: 1_042_000,
    });
    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;
    expect(decision.changedFields).toEqual(["status"]);
    expect(decision.body.draft.fields).toEqual({ status: "pending" });
    expect(decision.body.sent.fields).toEqual({ status: "approved" });
  });
});

describe("draftBodyFromReader", () => {
  it("fetches the draft the conversation's draftId points at", async () => {
    const calls: string[] = [];
    const reader: DraftReader = {
      conversation: conversationWith({ draftId: "drf_1" as ApplicationDraftId }),
      fetchDraft: async (draftId) => {
        calls.push(draftId);
        return draftWith(draftBody);
      },
    };
    expect(await draftBodyFromReader(reader)).toBe(draftBody);
    expect(calls).toEqual(["drf_1"]);
  });

  it("no draftId, no fetch; a draft already gone reads as no draft", async () => {
    let calls = 0;
    const noDraft: DraftReader = {
      conversation: conversationWith(),
      fetchDraft: async () => {
        calls++;
        return draftWith(draftBody);
      },
    };
    expect(await draftBodyFromReader(noDraft)).toBeNull();
    expect(calls).toBe(0);
    const gone: DraftReader = {
      conversation: conversationWith({ draftId: "drf_1" as ApplicationDraftId }),
      fetchDraft: async () => undefined,
    };
    expect(await draftBodyFromReader(gone)).toBeNull();
  });
});

describe("settings from the entry point", () => {
  // Type-only SDK imports keep the suite hermetic: the fixtures carry the entry
  // point discriminants as the SDK's enum values without loading the host runtime.
  const urlEntryPoint: EntryPointData = {
    type: "URL" as EntryPointTypesEnum.URL,
    data: { customContextProperties: { agent: "claims-reply", require_reason: "false" } },
  };

  it("reads the custom context properties off a URL entry point, and none off the others", () => {
    expect(entryPointProperties(urlEntryPoint)).toEqual({
      agent: "claims-reply",
      require_reason: "false",
    });
    expect(entryPointProperties({ type: "SIDE_PANEL" as EntryPointTypesEnum.SIDE_PANEL })).toEqual({});
    expect(entryPointProperties(undefined)).toEqual({});
  });

  it("the entry point wins over the query string, which stays as the fallback", () => {
    const raw = rawSettingsFrom(urlEntryPoint, "?agent=support-reply&overturn_api_key=key_1&scope_tag=ai");
    expect(raw.agent).toBe("claims-reply");
    expect(raw.overturn_api_key).toBe("key_1");
    const settings = settingsFrom(raw);
    expect(settings.agent).toBe("claims-reply");
    expect(settings.requireReason).toBe(false);
    expect(settings.scopeTag).toBe("ai");
    // With no entry point properties at all, the query string alone still configures the plugin.
    expect(settingsFrom(rawSettingsFrom(undefined, "?agent=support-reply")).agent).toBe("support-reply");
  });
});
