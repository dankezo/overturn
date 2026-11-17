import { describe, expect, it } from "vitest";
import { captureCanvas, EMPTY_FORM, formFrom } from "./canvas";
import { DEFAULT_SETTINGS, type DraftState } from "./capture";

const draft: DraftState = {
  text: "A reply long enough to be a draft, with enough words in it to matter for the case.",
  origin: "unknown",
  at: 1,
};

describe("captureCanvas", () => {
  it("before a draft exists the canvas is only the waiting line - the conversation is not read", () => {
    const c = captureCanvas({ draft: null, form: EMPTY_FORM, settings: DEFAULT_SETTINGS });
    expect(c.content.components).toHaveLength(1);
    expect(c.content.components[0]).toMatchObject({ type: "text", text: "Waiting for a draft" });
  });

  it("the form starts at origin unknown - it is never pre-answered", () => {
    const c = captureCanvas({
      draft,
      form: { ...EMPTY_FORM, draftText: draft.text, sentText: draft.text },
      settings: DEFAULT_SETTINGS,
    });
    const origin = c.content.components.find((x) => x.id === "draft_origin");
    expect(origin).toMatchObject({ type: "single-select", value: "unknown" });
    if (origin?.type !== "single-select") throw new Error("origin select missing");
    expect(origin.options.map((o) => o.id)).toEqual(["unknown", "ai", "manual"]);
  });

  it("the reason picker offers the support pack by default", () => {
    const c = captureCanvas({
      draft,
      form: { ...EMPTY_FORM, draftText: draft.text },
      settings: DEFAULT_SETTINGS,
    });
    const reason = c.content.components.find((x) => x.id === "reason_code");
    if (reason?.type !== "single-select") throw new Error("reason select missing");
    expect(reason.options.map((o) => o.id)).toContain("should_escalate");
    expect(reason.options.map((o) => o.id)).not.toContain("wrong_coverage_decision");
  });

  it("a saved result replaces the form with the status line", () => {
    const c = captureCanvas({
      draft: null,
      form: EMPTY_FORM,
      settings: DEFAULT_SETTINGS,
      lastResult: { kind: "edit", changed: true, dedup: false },
    });
    expect(c.content.components).toHaveLength(1);
    expect(c.content.components[0]).toMatchObject({ text: "Captured · edit saved as a case" });
  });

  it("a held capture asks for just the reason - the reply already went out", () => {
    const c = captureCanvas({
      draft,
      form: { ...EMPTY_FORM, draftText: draft.text, sentText: draft.text },
      settings: DEFAULT_SETTINGS,
      held: { changed: true, changedFields: [] },
    });
    expect(c.content.components[0]).toMatchObject({ text: "Pick why you changed the reply" });
    expect(c.content.components.some((x) => x.id === "draft_text")).toBe(false);
    expect(c.content.components.some((x) => x.id === "sent_text")).toBe(false);
    expect(c.content.components.some((x) => x.id === "reason_code")).toBe(true);
  });

  it("a held capture names the field that changed", () => {
    const c = captureCanvas({
      draft,
      form: { ...EMPTY_FORM, draftText: draft.text, sentText: draft.text },
      settings: DEFAULT_SETTINGS,
      held: { changed: true, changedFields: ["status"] },
    });
    expect(c.content.components[0]).toMatchObject({ text: "Pick why you changed status" });
  });
});

describe("formFrom", () => {
  it("parses defensively and defaults the origin to unknown", () => {
    expect(formFrom({})).toEqual(EMPTY_FORM);
    expect(formFrom({ draft_origin: "fin" }).origin).toBe("unknown");
    expect(formFrom({ draft_origin: "manual", reason_code: "wrong_answer" })).toMatchObject({
      origin: "manual",
      reasonCode: "wrong_answer",
    });
  });
});
