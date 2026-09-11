import { describe, expect, it } from "vitest";

import { canApproveExpense, requiresPersonalClassificationConfirmation } from "@/lib/expense-policy";
import { Expense } from "@/lib/types";

function buildExpense(overrides: Partial<Expense>): Expense {
  return {
    id: "expense_1",
    tripId: "trip_1",
    title: "Demo Expense",
    date: "2026-08-26",
    payerId: "member_1",
    settlementAmountMinor: 1000,
    settlementCurrency: "INR",
    originalAmountMinor: 1000,
    originalCurrency: "INR",
    postedAmountMinor: 1000,
    postedCurrency: "INR",
    fxRule: "posted",
    fxRate: null,
    splitMode: "personal",
    splitConfig: { participantIds: ["member_1"] },
    allocations: [{ memberId: "member_1", amountMinor: 1000 }],
    status: "draft",
    category: null,
    notes: "",
    likelyPersonal: { likely: true, confidence: "high", reasons: ["flag"] },
    personalClassificationConfirmed: false,
    receiptMatch: null,
    evidence: { statementTransactionId: null, receiptId: null },
    createdBy: "member_1",
    approvedBy: null,
    approvedAt: null,
    reopenedAt: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("expense approval policy", () => {
  it("blocks approval for unconfirmed likely-personal expenses", () => {
    const expense = buildExpense({ personalClassificationConfirmed: false, splitMode: "personal" });
    expect(requiresPersonalClassificationConfirmation(expense)).toBe(true);
    expect(canApproveExpense(expense).ok).toBe(false);
  });

  it("allows approval after explicit confirmation", () => {
    const expense = buildExpense({ personalClassificationConfirmed: true });
    expect(requiresPersonalClassificationConfirmation(expense)).toBe(false);
    expect(canApproveExpense(expense).ok).toBe(true);
  });

  it("allows deliberate shared split when confirmed", () => {
    const expense = buildExpense({
      splitMode: "equal",
      splitConfig: { participantIds: ["member_1", "member_2"] },
      allocations: [
        { memberId: "member_1", amountMinor: 500 },
        { memberId: "member_2", amountMinor: 500 },
      ],
      personalClassificationConfirmed: true,
    });
    expect(canApproveExpense(expense).ok).toBe(true);
  });
});
