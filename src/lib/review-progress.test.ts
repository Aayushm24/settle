import { describe, expect, it } from "vitest";

import { computeReviewProgress } from "@/lib/review-progress";
import { Expense, StatementTransaction } from "@/lib/types";

function makeTransaction(overrides: Partial<StatementTransaction>): StatementTransaction {
  return {
    id: "txn_1",
    sourceId: "src_1",
    sourceName: "statement.txt",
    uploaderId: "member_1",
    date: "2026-08-26",
    merchant: "Test merchant",
    originalAmountMinor: 1000,
    originalCurrency: "INR",
    postedAmountMinor: 1000,
    postedCurrency: "INR",
    inclusionState: "included",
    isCredit: false,
    isPayment: false,
    isFeeOrTax: false,
    fingerprint: "fp_1",
    reference: null,
    rawText: "260826 Test merchant INR 10.00",
    createdAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function makeExpense(overrides: Partial<Expense>): Expense {
  return {
    id: "expense_1",
    tripId: "trip_1",
    title: "Test expense",
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
    splitMode: "equal",
    splitConfig: { participantIds: ["member_1", "member_2"] },
    allocations: [],
    status: "approved",
    category: null,
    notes: "",
    likelyPersonal: { likely: false, confidence: "low", reasons: [] },
    personalClassificationConfirmed: true,
    receiptMatch: null,
    evidence: { statementTransactionId: "txn_1", receiptId: null },
    createdBy: "member_1",
    approvedBy: "member_1",
    approvedAt: "2026-08-26T00:00:00.000Z",
    reopenedAt: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("computeReviewProgress", () => {
  it("counts payment rows as reviewed", () => {
    const transactions = [makeTransaction({ id: "txn_payment", isPayment: true, inclusionState: "excluded" })];
    const result = computeReviewProgress(transactions, []);
    expect(result.reviewedTransactions).toBe(1);
    expect(result.autoResolvedPayments).toBe(1);
    expect(result.unresolvedTransactions).toBe(0);
  });

  it("counts excluded rows as reviewed", () => {
    const transactions = [makeTransaction({ id: "txn_excluded", inclusionState: "excluded" })];
    const result = computeReviewProgress(transactions, []);
    expect(result.reviewedTransactions).toBe(1);
    expect(result.excludedTransactions).toBe(1);
  });

  it("counts approved linked expenses as reviewed", () => {
    const transactions = [makeTransaction({ id: "txn_linked" })];
    const expenses = [
      makeExpense({
        id: "expense_linked",
        evidence: { statementTransactionId: "txn_linked", receiptId: null },
        status: "approved",
      }),
    ];
    const result = computeReviewProgress(transactions, expenses);
    expect(result.reviewedTransactions).toBe(1);
    expect(result.approvedTransactions).toBe(1);
  });

  it("keeps draft-linked transactions unresolved", () => {
    const transactions = [makeTransaction({ id: "txn_draft" })];
    const expenses = [
      makeExpense({
        id: "expense_draft",
        evidence: { statementTransactionId: "txn_draft", receiptId: null },
        status: "draft",
      }),
    ];
    const result = computeReviewProgress(transactions, expenses);
    expect(result.reviewedTransactions).toBe(0);
    expect(result.unresolvedTransactions).toBe(1);
  });

  it("does not count excluded transactions as reviewed when draft expense is still linked", () => {
    const transactions = [makeTransaction({ id: "txn_hidden", inclusionState: "excluded" })];
    const expenses = [
      makeExpense({
        id: "expense_hidden",
        evidence: { statementTransactionId: "txn_hidden", receiptId: null },
        status: "draft",
      }),
    ];

    const result = computeReviewProgress(transactions, expenses);
    expect(result.reviewedTransactions).toBe(0);
    expect(result.unresolvedTransactions).toBe(1);
  });
});
