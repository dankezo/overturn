import type {
  ApplicationComment,
  ApplicationCustomAttribute,
  ApplicationMessage,
  ApplicationPaginatedResults,
  ApplicationPaginationToken,
  ApplicationSingleConversation,
  EntryPointData,
  SingleConversationContext,
} from "@frontapp/plugin-sdk";
import type { ConversationSnapshot } from "./capture";

/**
 * The typed seam between Front's plugin SDK and the capture logic in capture.ts.
 *
 * The SDK's context objects are the only way in: a conversation context carries the
 * conversation but no messages on it - the messages and the internal comments are
 * listed through the context - the composer's draft is fetched by the draft id the
 * conversation carries, and the plugin's settings arrive on the context's entry
 * point. The reader interfaces below are structural slices of the SDK's own context
 * type (the method signatures are SingleConversationContext's), so the real context
 * objects satisfy them with no cast, and tests can fake just the slice they exercise.
 */
export interface ConversationReader {
  conversation: ApplicationSingleConversation | undefined;
  listMessages: SingleConversationContext["listMessages"];
  listComments: SingleConversationContext["listComments"];
}

/** A context that can fetch the draft its conversation points at. */
export interface DraftReader {
  conversation: ApplicationSingleConversation;
  fetchDraft: SingleConversationContext["fetchDraft"];
}

/** Pages are followed to the end of the list, with a cap so a bad token cannot loop forever. */
const MAX_PAGES = 20;

async function listAll<T>(
  fetchPage: (token?: ApplicationPaginationToken) => Promise<ApplicationPaginatedResults<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let token: ApplicationPaginationToken | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await fetchPage(token);
    all.push(...result.results);
    if (!result.nextPageToken) break;
    token = result.nextPageToken;
  }
  return all;
}

function isoDate(value: Date | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function messageRow(message: ApplicationMessage): ConversationSnapshot["messages"][number] {
  return {
    id: message.id,
    body: message.content?.body ?? "",
    contentType: message.content?.type ?? "text",
    kind: message.status === "inbound" ? "inbound" : "outbound",
    authorName: message.from.name ?? null,
    authorEmail: message.from.handle,
    createdAt: isoDate(message.date),
  };
}

function commentRow(comment: ApplicationComment): ConversationSnapshot["messages"][number] {
  return {
    id: comment.id,
    body: comment.content.body,
    // Front comments are markdown, not HTML: their `<` characters are text, not tags.
    contentType: "markdown",
    kind: "note",
    authorName: comment.author.name ?? null,
    authorEmail: comment.author.email,
    createdAt: isoDate(comment.createdAt),
  };
}

/** The conversation's custom-field attributes as the capture's field map, keyed by field name. */
export function customFieldsFrom(
  attributes: ReadonlyArray<ApplicationCustomAttribute>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const attribute of attributes) {
    const value = attribute.value instanceof Date ? attribute.value.toISOString() : attribute.value;
    fields[attribute.name] = value;
    // Also key by the field id: an installer copying the id out of Front's settings
    // (fld_...) must find the same value as one using the field name.
    if (attribute.id !== attribute.name) fields[attribute.id] = value;
  }
  return fields;
}

/**
 * The snapshot capture.ts works on, built from one context: the conversation's own
 * fields, its messages listed through the context, and its internal comments merged
 * in as notes, oldest first.
 */
export async function snapshotFromReader(reader: ConversationReader): Promise<ConversationSnapshot | null> {
  const conversation = reader.conversation;
  if (!conversation) return null;
  const [messages, comments] = await Promise.all([
    listAll((token) => reader.listMessages(token)),
    listAll((token) => reader.listComments(token)),
  ]);
  const rows = [...messages.map(messageRow), ...comments.map(commentRow)];
  rows.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  return {
    id: conversation.id,
    subject: conversation.subject ?? null,
    recipientName: conversation.recipient?.name ?? null,
    recipientEmail: conversation.recipient?.handle ?? null,
    messages: rows,
    customFields: customFieldsFrom(conversation.customFieldAttributes),
    url: `https://app.frontapp.com/open/${conversation.id}`,
  };
}

/**
 * The body of the draft the conversation points at, fetched through the context.
 * Null when the conversation has no draft or the draft is already gone.
 */
export async function draftBodyFromReader(reader: DraftReader): Promise<string | null> {
  const draftId = reader.conversation.draftId;
  if (!draftId) return null;
  const draft = await reader.fetchDraft(draftId);
  return draft?.content.body ?? null;
}

/**
 * The settings Front hands the plugin at launch. A plugin opened through a URL entry
 * point receives them as the entry point's custom context properties; the other
 * entry points carry none.
 */
export function entryPointProperties(entryPoint: EntryPointData | undefined): Record<string, string> {
  if (!entryPoint || !("data" in entryPoint)) return {};
  const data = entryPoint.data;
  if (!data || !("customContextProperties" in data)) return {};
  return data.customContextProperties;
}

/**
 * The raw settings capture's settingsFrom parses: the plugin page's query parameters
 * are the fallback (a hosted page can be configured by URL), and the entry point's
 * properties win wherever both carry the same key.
 */
export function rawSettingsFrom(
  entryPoint: EntryPointData | undefined,
  search: string,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(search)) raw[key] = value;
  for (const [key, value] of Object.entries(entryPointProperties(entryPoint))) raw[key] = value;
  return raw;
}
