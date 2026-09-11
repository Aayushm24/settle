import { Expense } from "@/lib/types";

export function requiresPersonalClassificationConfirmation(expense: Expense): boolean {
  return expense.likelyPersonal.likely && !expense.personalClassificationConfirmed;
}

export function canApproveExpense(expense: Expense): { ok: boolean; reason: string | null } {
  if (requiresPersonalClassificationConfirmation(expense)) {
    return {
      ok: false,
      reason: "Likely personal expense must be confirmed as personal or deliberately re-split before approval.",
    };
  }

  return { ok: true, reason: null };
}
