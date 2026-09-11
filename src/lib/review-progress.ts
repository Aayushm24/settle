import { Expense, StatementTransaction } from "@/lib/types";

export interface ReviewProgressSummary {
  totalTransactions: number;
  reviewedTransactions: number;
  unresolvedTransactions: number;
  autoResolvedPayments: number;
  excludedTransactions: number;
  approvedTransactions: number;
}

export function buildApprovedTransactionIdSet(expenses: Expense[]): Set<string> {
  const approved = new Set<string>();
  for (const expense of expenses) {
    if (expense.status !== "approved") {
      continue;
    }

    if (expense.evidence.statementTransactionId) {
      approved.add(expense.evidence.statementTransactionId);
    }
  }
  return approved;
}

export function buildUnapprovedTransactionIdSet(expenses: Expense[]): Set<string> {
  const pending = new Set<string>();
  for (const expense of expenses) {
    if (expense.status === "approved") {
      continue;
    }

    if (expense.evidence.statementTransactionId) {
      pending.add(expense.evidence.statementTransactionId);
    }
  }
  return pending;
}

export function isTransactionReviewed(
  transaction: StatementTransaction,
  approvedTransactionIds: Set<string>,
  unapprovedTransactionIds: Set<string> = new Set<string>(),
): boolean {
  if (transaction.isPayment) {
    return true;
  }
  if (transaction.inclusionState === "excluded") {
    return !unapprovedTransactionIds.has(transaction.id);
  }
  return approvedTransactionIds.has(transaction.id);
}

export function computeReviewProgress(
  transactions: StatementTransaction[],
  expenses: Expense[],
): ReviewProgressSummary {
  const approvedTransactionIds = buildApprovedTransactionIdSet(expenses);
  const unapprovedTransactionIds = buildUnapprovedTransactionIdSet(expenses);
  let reviewedTransactions = 0;
  let autoResolvedPayments = 0;
  let excludedTransactions = 0;

  for (const transaction of transactions) {
    if (transaction.isPayment) {
      autoResolvedPayments += 1;
    }
    if (transaction.inclusionState === "excluded") {
      excludedTransactions += 1;
    }
    if (isTransactionReviewed(transaction, approvedTransactionIds, unapprovedTransactionIds)) {
      reviewedTransactions += 1;
    }
  }

  const totalTransactions = transactions.length;
  const unresolvedTransactions = Math.max(totalTransactions - reviewedTransactions, 0);

  return {
    totalTransactions,
    reviewedTransactions,
    unresolvedTransactions,
    autoResolvedPayments,
    excludedTransactions,
    approvedTransactions: approvedTransactionIds.size,
  };
}
