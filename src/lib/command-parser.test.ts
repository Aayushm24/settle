import { describe, expect, it } from "vitest";

import { parseTransactionCommand } from "@/lib/command-parser";

const members = [
  { id: "m1", name: "Alex Roy" },
  { id: "m2", name: "Mira Shah" },
  { id: "m3", name: "Rohan Iyer" },
];

const receipts = [
  {
    id: "receipt_1",
    sourceName: "harbor-receipt.pdf",
    merchant: "Harbor Ferry",
    bookingIds: ["ZX-ALPHA-001"],
  },
  {
    id: "receipt_2",
    sourceName: "harbor-dinner.pdf",
    merchant: "Harbor Dinner",
    bookingIds: ["DINNER-42"],
  },
];

describe("parseTransactionCommand", () => {
  it("parses personal command", () => {
    const parsed = parseTransactionCommand("only me", members, "m1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.command.type).toBe("set_personal");
    }
  });

  it("parses split between everyone command", () => {
    const parsed = parseTransactionCommand("split between everyone", members, "m1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.command.type).toBe("split_all");
    }
  });

  it("parses split between named members", () => {
    const parsed = parseTransactionCommand("split between Mira, Rohan", members, "m1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.command.type).toBe("split_between");
      if (parsed.command.type === "split_between") {
        expect(parsed.command.participantIds).toEqual(["m2", "m3"]);
      }
    }
  });

  it("parses payer command", () => {
    const parsed = parseTransactionCommand("Mira paid", members, "m1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.command.type).toBe("set_payer");
      if (parsed.command.type === "set_payer") {
        expect(parsed.command.payerId).toBe("m2");
      }
    }
  });

  it("parses payer command with cash wording", () => {
    const parsed = parseTransactionCommand("Rohan paid this in cash", members, "m1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.command.type === "set_payer") {
      expect(parsed.command.payerId).toBe("m3");
    }
  });

  it("parses shared-by-everyone wording", () => {
    const parsed = parseTransactionCommand("the ferry was for all of us", members, "m1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.command.type).toBe("split_all");
    }
  });

  it("parses only-me wording variant", () => {
    const parsed = parseTransactionCommand("this was only me", members, "m1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.command.type).toBe("set_personal");
    }
  });

  it("parses receipt attach command", () => {
    const parsed = parseTransactionCommand("attach receipt ZX-ALPHA", members, "m1", receipts);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.command.type === "attach_receipt") {
      expect(parsed.command.receiptId).toBe("receipt_1");
    }
  });

  it("returns ambiguity error for receipt attach command", () => {
    const parsed = parseTransactionCommand("match this to receipt harbor", members, "m1", receipts);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.toLowerCase()).toContain("ambiguous");
    }
  });

  it("supports me in split command", () => {
    const parsed = parseTransactionCommand("split between me, Mira", members, "m1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.command.type === "split_between") {
      expect(parsed.command.participantIds).toEqual(["m1", "m2"]);
    }
  });

  it("returns help text when command is unknown", () => {
    const parsed = parseTransactionCommand("do magic", members, "m1");
    expect(parsed.ok).toBe(false);
  });
});
