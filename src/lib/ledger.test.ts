import { describe, expect, it } from "vitest";

import { computeMemberLedgers, computeMinimumTransfers, computeTransferPlan } from "@/lib/ledger";
import { Expense } from "@/lib/types";

function expense(overrides: Partial<Expense>): Expense {
  return {
    id: "expense",
    tripId: "trip",
    title: "expense",
    date: "2026-08-26",
    payerId: "a",
    settlementAmountMinor: 0,
    settlementCurrency: "INR",
    originalAmountMinor: null,
    originalCurrency: null,
    postedAmountMinor: null,
    postedCurrency: null,
    fxRule: "posted",
    fxRate: null,
    splitMode: "equal",
    splitConfig: { participantIds: ["a", "b"] },
    allocations: [],
    status: "approved",
    category: null,
    notes: "",
    likelyPersonal: { likely: false, confidence: "low", reasons: [] },
    personalClassificationConfirmed: true,
    receiptMatch: null,
    evidence: {
      statementTransactionId: null,
      receiptId: null,
    },
    createdBy: "a",
    approvedBy: "a",
    approvedAt: "2026-08-26T00:00:00.000Z",
    reopenedAt: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("ledger", () => {
  it("balances sum to zero", () => {
    const expenses = [
      expense({
        id: "e1",
        payerId: "a",
        settlementAmountMinor: 300,
        allocations: [
          { memberId: "a", amountMinor: 100 },
          { memberId: "b", amountMinor: 100 },
          { memberId: "c", amountMinor: 100 },
        ],
      }),
      expense({
        id: "e2",
        payerId: "b",
        settlementAmountMinor: 150,
        allocations: [
          { memberId: "a", amountMinor: 50 },
          { memberId: "b", amountMinor: 50 },
          { memberId: "c", amountMinor: 50 },
        ],
      }),
    ];

    const ledgers = computeMemberLedgers(["a", "b", "c"], expenses);
    expect(ledgers.reduce((sum, row) => sum + row.balanceMinor, 0)).toBe(0);
  });

  it("personal expense yields zero net impact", () => {
    const expenses = [
      expense({
        id: "e1",
        payerId: "a",
        settlementAmountMinor: 500,
        splitMode: "personal",
        allocations: [{ memberId: "a", amountMinor: 500 }],
      }),
    ];

    const ledgers = computeMemberLedgers(["a", "b"], expenses);
    expect(ledgers.find((entry) => entry.memberId === "a")?.balanceMinor).toBe(0);
    expect(ledgers.find((entry) => entry.memberId === "b")?.balanceMinor).toBe(0);
  });

  it("finds minimum transfer count", () => {
    const ledgers = [
      { memberId: "a", paidMinor: 500, owedMinor: 100, balanceMinor: 400 },
      { memberId: "b", paidMinor: 100, owedMinor: 300, balanceMinor: -200 },
      { memberId: "c", paidMinor: 0, owedMinor: 200, balanceMinor: -200 },
    ];

    const transfers = computeMinimumTransfers(ledgers);
    expect(transfers.length).toBe(2);
    expect(transfers.reduce((sum, transfer) => sum + transfer.amountMinor, 0)).toBe(400);
  });

  it("falls back to simplified strategy when member count exceeds bound", () => {
    const ledgers = Array.from({ length: 11 }, (_, index) => ({
      memberId: `m${index}`,
      paidMinor: 0,
      owedMinor: 0,
      balanceMinor: index < 5 ? 100 : index < 10 ? -50 : -250,
    }));

    const plan = computeTransferPlan(ledgers);
    expect(plan.strategy).toBe("simplified");
    expect(plan.transfers.length).toBeGreaterThan(0);
  });
});
