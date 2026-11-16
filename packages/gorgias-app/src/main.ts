import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  createPendingCapture,
  type DraftState,
  decideOnSend,
  orderFieldsFrom,
  quickReasons,
  type SendDecision,
  sentFromMessages,
  settingsFrom,
  statusLine,
  type TicketSnapshot,
} from "./capture";

/**
 * The Gorgias glue. A Gorgias widget is an iframe in the ticket sidebar: Gorgias hands it
 * the ticket id (and the app settings) as URL query parameters, and everything else -
 * the ticket, its messages, its order - comes from the Gorgias REST API. A widget cannot
 * see the reply box, so the draft reaches the panel from a recorded SDK run or from the
 * agent pasting it in; sends are observed as new agent messages on the ticket. All of the
 * decisions live in capture.ts (pure, tested); this file only moves data.
 */

interface WidgetConfig {
  settings: AppSettings;
  apiKey: string;
  /** The Gorgias account subdomain, e.g. `acme` for acme.gorgias.com. */
  gorgiasAccount: string;
  /** A Gorgias API token, used as the bearer token for the REST calls. */
  gorgiasToken: string;
  ticketId: string;
}

function configFromLocation(): WidgetConfig {
  const q = new URLSearchParams(window.location.search);
  const raw: Record<string, unknown> = {};
  for (const [k, v] of q.entries()) raw[k] = v;
  return {
    settings: settingsFrom(raw),
    apiKey: q.get("overturn_api_key") ?? "",
    gorgiasAccount: q.get("gorgias_account") ?? "",
    gorgiasToken: q.get("gorgias_api_token") ?? "",
    ticketId: q.get("ticket_id") ?? "",
  };
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const asString = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const asId = (v: unknown): string | number => (typeof v === "number" || typeof v === "string" ? v : "");

/** A Gorgias API ticket + its messages, normalised to the snapshot capture.ts works on. */
export function snapshotFromApi(ticketRaw: unknown, messagesRaw: unknown): TicketSnapshot {
  const t = asRecord(ticketRaw);
  const customer = asRecord(t.customer);
  const orderRaw = asRecord(t.order);
  const order =
    Object.keys(orderRaw).length > 0
      ? {
          id: asId(orderRaw.id),
          number: (orderRaw.name ?? orderRaw.number) as string | number | undefined,
          total: (orderRaw.total_price ?? orderRaw.total) as number | string | undefined,
          currency: asString(orderRaw.currency) ?? undefined,
          status: asString(orderRaw.financial_status) ?? asString(orderRaw.status) ?? undefined,
          fulfillmentStatus: asString(orderRaw.fulfillment_status) ?? undefined,
        }
      : null;
  const list = Array.isArray(messagesRaw)
    ? messagesRaw
    : ((asRecord(messagesRaw).data as unknown[] | undefined) ?? []);
  return {
    id: asId(t.id),
    subject: asString(t.subject),
    customerName: asString(customer.name),
    customerEmail: asString(customer.email),
    messages: list.map((mRaw) => {
      const m = asRecord(mRaw);
      const fromAgent = m.from_agent === true;
      const isNote = m.type === "internal-note" || m.channel === "internal-note";
      return {
        id: asId(m.id),
        body: asString(m.body_html) ?? asString(m.body_text) ?? asString(m.body) ?? "",
        kind: isNote ? "note" : fromAgent ? "agent" : "customer",
        authorEmail: asString(asRecord(m.sender).email),
        createdAt: asString(m.created_datetime),
      };
    }),
    order,
    fields: {},
    url: null,
  };
}

async function main(): Promise<void> {
  const cfg = configFromLocation();
  const { settings } = cfg;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const statusEl = $("status");
  const orderEl = $("order");
  const draftBox = $<HTMLTextAreaElement>("draft");
  const markBtn = $<HTMLButtonElement>("mark");
  const chipsEl = $("reasons");
  const noteEl = $<HTMLInputElement>("note");
  const bannerEl = $("banner");

  let ticket: TicketSnapshot | null = null;
  let draft: DraftState | null = null;
  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  let seen = new Set<number | string>();
  const pending = createPendingCapture();

  const gorgias = async (path: string): Promise<unknown> => {
    const res = await fetch(`https://${cfg.gorgiasAccount}.gorgias.com/api${path}`, {
      headers: { authorization: `Bearer ${cfg.gorgiasToken}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`gorgias ${res.status}`);
    return res.json() as Promise<unknown>;
  };

  const post = async (decision: SendDecision): Promise<void> => {
    if (decision.action !== "capture") return;
    try {
      const res = await fetch(`${settings.baseUrl}/v1/capture`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(decision.body),
      });
      if (!res.ok) throw new Error(`capture ${res.status}`);
      const r = (await res.json()) as CaptureResult;
      lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
      draft = null;
      pending.clear();
    } catch {
      bannerEl.textContent = "Overturn could not save this correction (network).";
    }
    render();
  };

  const runDecision = async (
    send: NonNullable<ReturnType<typeof sentFromMessages>>,
    reasonCode: string | null,
  ): Promise<void> => {
    if (!ticket || !draft) return;
    const decision = decideOnSend({
      ticket,
      draft,
      draftFields: {},
      send,
      reasonCode,
      reason: noteEl.value,
      actor: null,
      settings,
      now: Date.now(),
    });
    if (decision.action === "need-reason") {
      pending.hold(decision, () =>
        decideOnSend({
          ticket: ticket as TicketSnapshot,
          draft: draft as DraftState,
          draftFields: {},
          send,
          reasonCode: pickedReason,
          reason: noteEl.value,
          actor: null,
          settings,
          now: Date.now(),
        }),
      );
      bannerEl.textContent = "Pick why you changed the reply - the capture is held until you do.";
      render();
      return;
    }
    await post(decision);
  };

  let pickedReason: string | null = null;
  for (const r of quickReasons(settings)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = r.label;
    b.addEventListener("click", () => {
      pickedReason = r.code;
      for (const c of Array.from(chipsEl.children)) c.classList.toggle("on", c === b);
      if (pending.pending()) {
        const d = pending.resolve();
        if (d) void post(d);
      }
    });
    chipsEl.appendChild(b);
  }

  markBtn.addEventListener("click", () => {
    const text = draftBox.value.trim();
    if (text.length >= settings.minDraftChars) {
      draft = { text, origin: "manual", at: Date.now() };
      lastResult = null;
      render();
    }
  });

  function render(): void {
    statusEl.textContent = statusLine(draft, lastResult);
    if (ticket) {
      const f = orderFieldsFrom(ticket);
      orderEl.textContent =
        f.order_number !== undefined
          ? `Order ${String(f.order_number)}${f.order_total !== undefined ? ` · ${String(f.order_total)} ${String(f.order_currency ?? "")}` : ""}${f.order_status !== undefined ? ` · ${String(f.order_status)}` : ""}`
          : "";
    }
    draftBox.style.display = draft ? "none" : "";
    markBtn.style.display = draft ? "none" : "";
  }

  if (!cfg.ticketId || !cfg.gorgiasAccount) {
    statusEl.textContent = "Waiting for a ticket";
    return;
  }

  const load = async (): Promise<void> => {
    const [t, msgs] = await Promise.all([
      gorgias(`/tickets/${cfg.ticketId}`),
      gorgias(`/tickets/${cfg.ticketId}/messages`),
    ]);
    const first = ticket === null;
    ticket = snapshotFromApi(t, msgs);
    if (first) {
      seen = new Set(ticket.messages.map((m) => m.id));
      // A drafting agent that recorded its run is found by the ticket's external id.
      try {
        const res = await fetch(
          `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`gr:${ticket.id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
          { headers: { authorization: `Bearer ${cfg.apiKey}` } },
        );
        if (res.ok) {
          const found = (await res.json()) as { items?: Array<{ id: string; output: unknown }> };
          const run = found.items?.[0];
          if (run && typeof run.output === "string" && run.output.trim()) {
            draft = { text: run.output, origin: "recorded", runId: run.id, at: Date.now() };
          }
        }
      } catch {
        // no recorded draft; the agent can mark one by hand
      }
      render();
      return;
    }
    const send = sentFromMessages(seen, ticket.messages, settings);
    for (const m of ticket.messages) seen.add(m.id);
    if (send && draft && !pending.pending()) await runDecision(send, pickedReason);
    render();
  };

  try {
    await load();
  } catch {
    statusEl.textContent = "Could not load this ticket from Gorgias.";
    return;
  }
  window.setInterval(() => {
    void load().catch(() => undefined);
  }, 5000);
}

void main();
