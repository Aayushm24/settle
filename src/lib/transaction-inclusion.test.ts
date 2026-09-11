import { describe, expect, it } from "vitest";

import {
  excludeTransactionWithLinkedDraft,
  includeTransactionWithRestore,
} from "@/lib/transaction-inclusion";
import { Expense, ExpenseComment, StatementTransaction } from "@/lib/types";

function buildTransaction(overrides: Partial<StatementTransaction>): StatementTransaction {
  return {
    id: "txn_1",
    sourceId: "src_1",
    sourceName: "statement.txt",
    uploaderId: "member_1",
    date: "2026-08-26",
    merchant: "Ferry",
    originalAmountMinor: 1200,
    originalCurrency: "INR",
    postedAmountMinor: 1200,
    postedCurrency: "INR",
    inclusionState: "included",
    isCredit: false,
    isPayment: false,
    isFeeOrTax: false,
    fingerprint: "fp_1",
    reference: null,
    rawText: "260826 Ferry INR 12.00",
    createdAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function buildExpense(overrides: Partial<Expense>): Expense {
  return {
    id: "expense_1",
    tripId: "trip_1",
    title: "Ferry",
    date: "2026-08-26",
    payerId: "member_1",
    settlementAmountMinor: 1200,
    settlementCurrency: "INR",
    originalAmountMinor: 1200,
    originalCurrency: "INR",
    postedAmountMinor: 1200,
    postedCurrency: "INR",
    fxRule: "posted",
    fxRate: null,
    splitMode: "equal",
    splitConfig: { participantIds: ["member_1", "member_2"] },
    allocations: [
      { memberId: "member_1", amountMinor: 600 },
      { memberId: "member_2", amountMinor: 600 },
    ],
    status: "draft",
    category: null,
    notes: "",
    likelyPersonal: { likely: false, confidence: "low", reasons: [] },
    personalClassificationConfirmed: true,
    receiptMatch: null,
    evidence: { statementTransactionId: "txn_1", receiptId: null },
    createdBy: "member_1",
    approvedBy: null,
    approvedAt: null,
    reopenedAt: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function buildComment(overrides: Partial<ExpenseComment>): ExpenseComment {
  return {
    id: "comment_1",
    expenseId: "expense_1",
    memberId: "member_1",
    body: "Needs review",
    createdAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("transaction inclusion domain actions", () => {
  it("excludes a transaction and removes linked unapproved draft atomically", () => {
    const transaction = buildTransaction({ id: "txn_abc" });
    const expense = buildExpense({ id: "exp_abc", evidence: { statementTransactionId: "txn_abc", receiptId: null } });
    const comment = buildComment({ id: "comment_abc", expenseId: "exp_abc" });

    const result = excludeTransactionWithLinkedDraft([transaction], [expense], [comment], "txn_abc");

    expect(result.ok).toBe(true);
    expect(result.transactions[0].inclusionState).toBe("excluded");
    expect(result.expenses).toHaveLength(0);
    expect(result.comments).toHaveLength(0);
    expect(result.removedExpense?.id).toBe("exp_abc");
    expect(result.removedComments).toHaveLength(1);
  });

  it("blocks exclusion when linked expense is approved", () => {
    const result = excludeTransactionWithLinkedDraft(
      [buildTransaction({ id: "txn_approved" })],
      [
        buildExpense({
          id: "exp_approved",
          evidence: { statementTransactionId: "txn_approved", receiptId: null },
          status: "approved",
          approvedBy: "member_1",
          approvedAt: "2026-08-26T00:00:00.000Z",
        }),
      ],
      [],
      "txn_approved",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("approved expense");
  });

  it("restores the removed draft and comments on include undo", () => {
    const transaction = buildTransaction({ id: "txn_restore", inclusionState: "excluded" });
    const removedExpense = buildExpense({
      id: "exp_restore",
      evidence: { statementTransactionId: "txn_restore", receiptId: null },
    });
    const removedComment = buildComment({ id: "comment_restore", expenseId: "exp_restore" });

    const result = includeTransactionWithRestore([transaction], [], [], "txn_restore", {
      expense: removedExpense,
      comments: [removedComment],
    });

    expect(result.ok).toBe(true);
    expect(result.transactions[0].inclusionState).toBe("included");
    expect(result.expenses[0].id).toBe("exp_restore");
    expect(result.comments[0].id).toBe("comment_restore");
    expect(result.restoredExpense).toBe(true);
  });
});
