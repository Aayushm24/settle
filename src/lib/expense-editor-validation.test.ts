import { describe, expect, it } from "vitest";

import { validateExpenseEditorInput } from "@/lib/expense-editor-validation";

function buildInput(overrides: Partial<Parameters<typeof validateExpenseEditorInput>[0]> = {}) {
  return {
    expenseId: "expense_1",
    currency: "INR",
    memberIds: ["m1", "m2"],
    title: "Ferry",
    date: "2026-08-26",
    payerId: "m1",
    amountText: "120.00",
    splitMode: "equal" as const,
    participantIds: ["m1", "m2"],
    exactByMemberId: { m1: "60", m2: "60" },
    weightByMemberId: { m1: "1", m2: "1" },
    notes: "",
    fxRule: "posted" as const,
    fxRateText: "",
    ...overrides,
  };
}

describe("validateExpenseEditorInput", () => {
  it("returns inline date and amount errors", () => {
    const result = validateExpenseEditorInput(
      buildInput({
        date: "2026-02-31",
        amountText: "nope",
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.date).toBeTruthy();
      expect(result.errors.amount).toBeTruthy();
    }
  });

  it("validates exact split total", () => {
    const result = validateExpenseEditorInput(
      buildInput({
        splitMode: "exact",
        exactByMemberId: { m1: "10", m2: "20" },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.split).toContain("add up");
    }
  });

  it("requires a fixed-trip fx rate", () => {
    const result = validateExpenseEditorInput(
      buildInput({
        fxRule: "fixed_trip",
        fxRateText: "",
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.fxRate).toContain("required");
    }
  });

  it("returns normalized payload for valid input", () => {
    const result = validateExpenseEditorInput(buildInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.settlementAmountMinor).toBe(12000);
      expect(result.value.splitConfig.participantIds).toEqual(["m1", "m2"]);
    }
  });
});
