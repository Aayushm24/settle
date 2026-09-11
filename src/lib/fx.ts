import { convertMinorUnitsByRate } from "@/lib/money";
import { Expense, FxRule, StatementTransaction, Trip } from "@/lib/types";

export function resolveSettlementAmountFromTransaction(
  transaction: StatementTransaction,
  trip: Trip,
): { settlementAmountMinor: number; fxRule: FxRule; fxRate: number | null } {
  if (transaction.originalCurrency === trip.settlementCurrency) {
    return {
      settlementAmountMinor: transaction.originalAmountMinor,
      fxRule: "posted",
      fxRate: 1,
    };
  }

  if (
    trip.defaultFxRule === "posted" &&
    transaction.postedCurrency === trip.settlementCurrency &&
    transaction.postedAmountMinor !== null
  ) {
    return {
      settlementAmountMinor: transaction.postedAmountMinor,
      fxRule: "posted",
      fxRate: null,
    };
  }

  if (trip.defaultFxRule === "fixed_trip" && trip.fixedTripRate !== null) {
    return {
      settlementAmountMinor: convertMinorUnitsByRate(
        transaction.originalAmountMinor,
        transaction.originalCurrency,
        trip.settlementCurrency,
        trip.fixedTripRate,
      ),
      fxRule: "fixed_trip",
      fxRate: trip.fixedTripRate,
    };
  }

  if (
    transaction.postedCurrency === trip.settlementCurrency &&
    transaction.postedAmountMinor !== null
  ) {
    return {
      settlementAmountMinor: transaction.postedAmountMinor,
      fxRule: "posted",
      fxRate: null,
    };
  }

  return {
    settlementAmountMinor: transaction.originalAmountMinor,
    fxRule: "daily_market",
    fxRate: null,
  };
}

export function recomputeSettlementAmountForExpense(
  expense: Expense,
  trip: Trip,
  fxRule: FxRule,
  fxRate: number | null,
): number | null {
  if (fxRule === "posted") {
    if (expense.postedCurrency === trip.settlementCurrency && expense.postedAmountMinor !== null) {
      return expense.postedAmountMinor;
    }
    if (expense.originalCurrency === trip.settlementCurrency && expense.originalAmountMinor !== null) {
      return expense.originalAmountMinor;
    }
    return null;
  }

  if (fxRule === "fixed_trip") {
    if (!expense.originalCurrency || expense.originalAmountMinor === null || fxRate === null) {
      return null;
    }

    return convertMinorUnitsByRate(
      expense.originalAmountMinor,
      expense.originalCurrency,
      trip.settlementCurrency,
      fxRate,
    );
  }

  if (expense.originalCurrency === trip.settlementCurrency && expense.originalAmountMinor !== null) {
    return expense.originalAmountMinor;
  }

  if (expense.postedCurrency === trip.settlementCurrency && expense.postedAmountMinor !== null) {
    return expense.postedAmountMinor;
  }

  return null;
}
