import { parseIsoDate } from "@/lib/date";
import { parseAmountToMinorUnits } from "@/lib/money";
import { FxRule, SplitConfig, SplitMode } from "@/lib/types";

export interface ExpenseEditorFieldErrors {
  title?: string;
  date?: string;
  payerId?: string;
  amount?: string;
  participants?: string;
  fxRate?: string;
  split?: string;
}

export interface ValidateExpenseEditorParams {
  expenseId: string;
  currency: string;
  memberIds: string[];
  title: string;
  date: string;
  payerId: string;
  amountText: string;
  splitMode: SplitMode;
  participantIds: string[];
  exactByMemberId: Record<string, string>;
  weightByMemberId: Record<string, string>;
  notes: string;
  fxRule: FxRule;
  fxRateText: string;
}

export type ValidateExpenseEditorResult =
  | {
      ok: true;
      value: {
        expenseId: string;
        title: string;
        date: string;
        payerId: string;
        settlementAmountMinor: number;
        splitMode: SplitMode;
        splitConfig: SplitConfig;
        notes: string;
        fxRule: FxRule;
        fxRate: number | null;
      };
    }
  | {
      ok: false;
      errors: ExpenseEditorFieldErrors;
    };

function uniqueParticipantIds(participantIds: string[], memberIds: string[]): string[] {
  const allowed = new Set(memberIds);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const participantId of participantIds) {
    if (!allowed.has(participantId) || seen.has(participantId)) {
      continue;
    }
    seen.add(participantId);
    normalized.push(participantId);
  }
  return normalized;
}

export function validateExpenseEditorInput(
  input: ValidateExpenseEditorParams,
): ValidateExpenseEditorResult {
  const errors: ExpenseEditorFieldErrors = {};
  const title = input.title.trim();
  if (!title) {
    errors.title = "Title is required.";
  }

  const date = input.date.trim();
  if (!date) {
    errors.date = "Date is required.";
  } else {
    try {
      parseIsoDate(date);
    } catch {
      errors.date = "Date must be a valid calendar date.";
    }
  }

  if (!input.memberIds.includes(input.payerId)) {
    errors.payerId = "Choose a valid payer.";
  }

  let settlementAmountMinor = 0;
  try {
    settlementAmountMinor = parseAmountToMinorUnits(input.amountText, input.currency);
    if (settlementAmountMinor <= 0) {
      errors.amount = "Amount must be greater than zero.";
    }
  } catch {
    errors.amount = "Amount must be a valid number.";
  }

  const participantIds = uniqueParticipantIds(input.participantIds, input.memberIds);
  if (input.splitMode === "personal") {
    if (participantIds.length !== 1 || participantIds[0] !== input.payerId) {
      errors.participants = "Personal split must include only the payer.";
    }
  } else if (participantIds.length === 0) {
    errors.participants = "Select at least one participant.";
  }

  let splitConfig: SplitConfig = { participantIds };
  if (input.splitMode === "exact") {
    const exactAmountByMemberId: Record<string, number> = {};
    let exactTotal = 0;
    for (const participantId of participantIds) {
      const rawAmount = input.exactByMemberId[participantId] ?? "";
      try {
        const amountMinor = parseAmountToMinorUnits(rawAmount, input.currency);
        if (amountMinor < 0) {
          errors.split = "Exact split values cannot be negative.";
          break;
        }
        exactAmountByMemberId[participantId] = amountMinor;
        exactTotal += amountMinor;
      } catch {
        errors.split = "Enter valid exact amounts for each participant.";
        break;
      }
    }

    if (!errors.split && exactTotal !== settlementAmountMinor) {
      errors.split = "Exact split must add up to the settlement amount.";
    }

    splitConfig = {
      participantIds,
      exactAmountByMemberId,
    };
  }

  if (input.splitMode === "weighted") {
    const weightByMemberId: Record<string, number> = {};
    for (const participantId of participantIds) {
      const rawWeight = input.weightByMemberId[participantId] ?? "";
      const weight = Number.parseInt(rawWeight, 10);
      if (!Number.isInteger(weight) || weight <= 0) {
        errors.split = "Weighted split requires positive integer weights.";
        break;
      }
      weightByMemberId[participantId] = weight;
    }

    splitConfig = {
      participantIds,
      weightByMemberId,
    };
  }

  const fxRateText = input.fxRateText.trim();
  let fxRate: number | null = null;
  if (fxRateText) {
    fxRate = Number.parseFloat(fxRateText);
    if (!Number.isFinite(fxRate) || fxRate <= 0) {
      errors.fxRate = "FX rate must be a positive number.";
    }
  }
  if (input.fxRule === "fixed_trip" && fxRate === null) {
    errors.fxRate = "FX rate is required when using fixed trip rate.";
  }

  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    value: {
      expenseId: input.expenseId,
      title,
      date,
      payerId: input.payerId,
      settlementAmountMinor,
      splitMode: input.splitMode,
      splitConfig,
      notes: input.notes,
      fxRule: input.fxRule,
      fxRate,
    },
  };
}
