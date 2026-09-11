import { Expense, ExpenseComment, StatementTransaction } from "@/lib/types";

export interface ExcludeTransactionMutation {
  ok: boolean;
  error: string | null;
  transactions: StatementTransaction[];
  expenses: Expense[];
  comments: ExpenseComment[];
  removedExpense: Expense | null;
  removedComments: ExpenseComment[];
}

export interface IncludeTransactionMutation {
  ok: boolean;
  error: string | null;
  transactions: StatementTransaction[];
  expenses: Expense[];
  comments: ExpenseComment[];
  restoredExpense: boolean;
}

function updateInclusionState(
  transactions: StatementTransaction[],
  transactionId: string,
  inclusionState: "included" | "excluded",
): StatementTransaction[] | null {
  const index = transactions.findIndex((transaction) => transaction.id === transactionId);
  if (index < 0) {
    return null;
  }

  const nextTransactions = [...transactions];
  nextTransactions[index] = {
    ...nextTransactions[index],
    inclusionState,
  };
  return nextTransactions;
}

export function excludeTransactionWithLinkedDraft(
  transactions: StatementTransaction[],
  expenses: Expense[],
  comments: ExpenseComment[],
  transactionId: string,
): ExcludeTransactionMutation {
  const nextTransactions = updateInclusionState(transactions, transactionId, "excluded");
  if (!nextTransactions) {
    return {
      ok: false,
      error: "Transaction not found.",
      transactions,
      expenses,
      comments,
      removedExpense: null,
      removedComments: [],
    };
  }

  const linkedExpense = expenses.find(
    (expense) => expense.evidence.statementTransactionId === transactionId,
  );
  if (linkedExpense?.status === "approved") {
    return {
      ok: false,
      error: "This transaction has an approved expense. Reopen or remove it before excluding.",
      transactions,
      expenses,
      comments,
      removedExpense: null,
      removedComments: [],
    };
  }

  if (!linkedExpense) {
    return {
      ok: true,
      error: null,
      transactions: nextTransactions,
      expenses,
      comments,
      removedExpense: null,
      removedComments: [],
    };
  }

  const nextExpenses = expenses.filter((expense) => expense.id !== linkedExpense.id);
  const removedComments = comments.filter((comment) => comment.expenseId === linkedExpense.id);
  const nextComments = comments.filter((comment) => comment.expenseId !== linkedExpense.id);

  return {
    ok: true,
    error: null,
    transactions: nextTransactions,
    expenses: nextExpenses,
    comments: nextComments,
    removedExpense: linkedExpense,
    removedComments,
  };
}

export function includeTransactionWithRestore(
  transactions: StatementTransaction[],
  expenses: Expense[],
  comments: ExpenseComment[],
  transactionId: string,
  restore?: {
    expense: Expense | null;
    comments?: ExpenseComment[];
  },
): IncludeTransactionMutation {
  const nextTransactions = updateInclusionState(transactions, transactionId, "included");
  if (!nextTransactions) {
    return {
      ok: false,
      error: "Transaction not found.",
      transactions,
      expenses,
      comments,
      restoredExpense: false,
    };
  }

  const restoreExpense = restore?.expense ?? null;
  if (!restoreExpense) {
    return {
      ok: true,
      error: null,
      transactions: nextTransactions,
      expenses,
      comments,
      restoredExpense: false,
    };
  }

  const existingLinked = expenses.some(
    (expense) => expense.evidence.statementTransactionId === transactionId,
  );
  if (existingLinked) {
    return {
      ok: true,
      error: null,
      transactions: nextTransactions,
      expenses,
      comments,
      restoredExpense: false,
    };
  }

  return {
    ok: true,
    error: null,
    transactions: nextTransactions,
    expenses: [restoreExpense, ...expenses],
    comments: [...(restore?.comments ?? []), ...comments],
    restoredExpense: true,
  };
}
