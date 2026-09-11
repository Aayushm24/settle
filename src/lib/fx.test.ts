import { describe, expect, it } from "vitest";

import { recomputeSettlementAmountForExpense, resolveSettlementAmountFromTransaction } from "@/lib/fx";
import { Expense, StatementTransaction, Trip } from "@/lib/types";

const trip: Trip = {
  id: "trip_1",
  creatorName: "Demo",
  name: "Demo",
  startDate: "2026-08-23",
  endDate: "2026-09-02",
  settlementCurrency: "INR",
  defaultFxRule: "posted",
  fixedTripRate: null,
  createdAt: "2026-08-23T00:00:00.000Z",
};

function buildTransaction(overrides: Partial<StatementTransaction>): StatementTransaction {
  return {
    id: "txn_1",
    sourceId: "src_1",
    sourceName: "demo.txt",
    uploaderId: "member_1",
    date: "2026-08-26",
    merchant: "Transit",
    originalAmountMinor: 20200,
    originalCurrency: "IDR",
    postedAmountMinor: 10931,
    postedCurrency: "INR",
    inclusionState: "included",
    isCredit: false,
    isPayment: false,
    isFeeOrTax: false,
    fingerprint: "fp1",
    reference: null,
    rawText: "row",
    createdAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function buildExpense(overrides: Partial<Expense>): Expense {
  return {
    id: "expense_1",
    tripId: "trip_1",
    title: "Transit",
    date: "2026-08-26",
    payerId: "member_1",
    settlementAmountMinor: 10931,
    settlementCurrency: "INR",
    originalAmountMinor: 20200,
    originalCurrency: "IDR",
    postedAmountMinor: 10931,
    postedCurrency: "INR",
    fxRule: "posted",
    fxRate: null,
    splitMode: "equal",
    splitConfig: { participantIds: ["member_1", "member_2"] },
    allocations: [
      { memberId: "member_1", amountMinor: 5466 },
      { memberId: "member_2", amountMinor: 5465 },
    ],
    status: "draft",
    category: null,
    notes: "",
    likelyPersonal: { likely: false, confidence: "low", reasons: [] },
    personalClassificationConfirmed: true,
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

describe("fx helpers", () => {
  it("resolves transaction settlement using fixed-trip rate via major units", () => {
    const transaction = buildTransaction({ postedAmountMinor: null, postedCurrency: null });
    const fixedTrip = { ...trip, defaultFxRule: "fixed_trip" as const, fixedTripRate: 0.00541 };
    const resolved = resolveSettlementAmountFromTransaction(transaction, fixedTrip);

    expect(resolved.fxRule).toBe("fixed_trip");
    expect(resolved.settlementAmountMinor).toBe(10928);
  });

  it("recomputes settlement when fx rule or rate changes", () => {
    const expense = buildExpense({ postedAmountMinor: 10931, postedCurrency: "INR" });
    const posted = recomputeSettlementAmountForExpense(expense, trip, "posted", null);
    const fixed = recomputeSettlementAmountForExpense(expense, trip, "fixed_trip", 0.00541);

    expect(posted).toBe(10931);
    expect(fixed).toBe(10928);
  });

  it("supports three-decimal settlement precision during recompute", () => {
    const bhdTrip = { ...trip, settlementCurrency: "BHD" };
    const expense = buildExpense({
      originalAmountMinor: 12345,
      originalCurrency: "USD",
      postedAmountMinor: null,
      postedCurrency: null,
      settlementCurrency: "BHD",
    });

    const fixed = recomputeSettlementAmountForExpense(expense, bhdTrip, "fixed_trip", 0.3771);
    expect(fixed).toBe(46553);
  });
});
