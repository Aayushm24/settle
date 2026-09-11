import { Expense, MemberLedger, Transfer } from "@/lib/types";

const MAX_EXACT_MEMBERS = 10;
const MAX_SEARCH_STATES = 200000;

export function computeMemberLedgers(
  memberIds: string[],
  approvedExpenses: Expense[],
): MemberLedger[] {
  const paidByMember = new Map<string, number>();
  const owedByMember = new Map<string, number>();

  for (const memberId of memberIds) {
    paidByMember.set(memberId, 0);
    owedByMember.set(memberId, 0);
  }

  for (const expense of approvedExpenses) {
    if (expense.status !== "approved") {
      continue;
    }

    paidByMember.set(
      expense.payerId,
      (paidByMember.get(expense.payerId) ?? 0) + expense.settlementAmountMinor,
    );

    let allocationSum = 0;
    for (const allocation of expense.allocations) {
      allocationSum += allocation.amountMinor;
      owedByMember.set(
        allocation.memberId,
        (owedByMember.get(allocation.memberId) ?? 0) + allocation.amountMinor,
      );
    }

    if (allocationSum !== expense.settlementAmountMinor) {
      throw new Error(`Allocations do not sum for expense ${expense.id}`);
    }
  }

  const ledgers = memberIds.map((memberId) => {
    const paidMinor = paidByMember.get(memberId) ?? 0;
    const owedMinor = owedByMember.get(memberId) ?? 0;
    return {
      memberId,
      paidMinor,
      owedMinor,
      balanceMinor: paidMinor - owedMinor,
    };
  });

  const totalBalance = ledgers.reduce((sum, ledger) => sum + ledger.balanceMinor, 0);
  if (totalBalance !== 0) {
    throw new Error("Ledger is not zero-sum");
  }

  return ledgers;
}

interface SettlementResult {
  transfers: Transfer[];
  transferCount: number;
  totalTransferredMinor: number;
}

export interface TransferComputation {
  transfers: Transfer[];
  strategy: "exact" | "simplified";
}

function compareTransfers(left: Transfer[], right: Transfer[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const leftValue = `${left[index].fromMemberId}->${left[index].toMemberId}:${left[index].amountMinor}`;
    const rightValue = `${right[index].fromMemberId}->${right[index].toMemberId}:${right[index].amountMinor}`;
    const cmp = leftValue.localeCompare(rightValue);
    if (cmp !== 0) {
      return cmp;
    }
  }

  return left.length - right.length;
}

export function computeMinimumTransfers(ledgers: MemberLedger[]): Transfer[] {
  return computeTransferPlan(ledgers).transfers;
}

function computeSimplifiedTransfers(ledgers: MemberLedger[]): Transfer[] {
  const debtors = ledgers
    .filter((ledger) => ledger.balanceMinor < 0)
    .map((ledger) => ({ memberId: ledger.memberId, amountMinor: -ledger.balanceMinor }))
    .sort((left, right) => {
      if (right.amountMinor !== left.amountMinor) {
        return right.amountMinor - left.amountMinor;
      }
      return left.memberId.localeCompare(right.memberId);
    });

  const creditors = ledgers
    .filter((ledger) => ledger.balanceMinor > 0)
    .map((ledger) => ({ memberId: ledger.memberId, amountMinor: ledger.balanceMinor }))
    .sort((left, right) => {
      if (right.amountMinor !== left.amountMinor) {
        return right.amountMinor - left.amountMinor;
      }
      return left.memberId.localeCompare(right.memberId);
    });

  const transfers: Transfer[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amountMinor = Math.min(debtor.amountMinor, creditor.amountMinor);
    if (amountMinor <= 0) {
      break;
    }

    transfers.push({
      fromMemberId: debtor.memberId,
      toMemberId: creditor.memberId,
      amountMinor,
    });

    debtor.amountMinor -= amountMinor;
    creditor.amountMinor -= amountMinor;

    if (debtor.amountMinor === 0) {
      debtorIndex += 1;
    }
    if (creditor.amountMinor === 0) {
      creditorIndex += 1;
    }
  }

  return transfers;
}

export function computeTransferPlan(ledgers: MemberLedger[]): TransferComputation {
  if (ledgers.length > MAX_EXACT_MEMBERS) {
    return {
      transfers: computeSimplifiedTransfers(ledgers),
      strategy: "simplified",
    };
  }

  const debtors = ledgers
    .filter((ledger) => ledger.balanceMinor < 0)
    .map((ledger) => ({ memberId: ledger.memberId, amountMinor: -ledger.balanceMinor }))
    .sort((left, right) => left.memberId.localeCompare(right.memberId));

  const creditors = ledgers
    .filter((ledger) => ledger.balanceMinor > 0)
    .map((ledger) => ({ memberId: ledger.memberId, amountMinor: ledger.balanceMinor }))
    .sort((left, right) => left.memberId.localeCompare(right.memberId));

  let best: SettlementResult | null = null;
  let exploredStates = 0;
  let exhaustedBudget = false;

  const search = (currentDebtors: typeof debtors, currentCreditors: typeof creditors, path: Transfer[]) => {
    exploredStates += 1;
    if (exploredStates > MAX_SEARCH_STATES) {
      exhaustedBudget = true;
      return;
    }

    const nextDebtorIndex = currentDebtors.findIndex((debtor) => debtor.amountMinor > 0);
    if (nextDebtorIndex === -1) {
      const totalTransferredMinor = path.reduce((sum, transfer) => sum + transfer.amountMinor, 0);
      const candidate: SettlementResult = {
        transfers: [...path],
        transferCount: path.length,
        totalTransferredMinor,
      };

      if (!best) {
        best = candidate;
        return;
      }

      if (candidate.transferCount < best.transferCount) {
        best = candidate;
        return;
      }

      if (
        candidate.transferCount === best.transferCount &&
        candidate.totalTransferredMinor < best.totalTransferredMinor
      ) {
        best = candidate;
        return;
      }

      if (
        candidate.transferCount === best.transferCount &&
        candidate.totalTransferredMinor === best.totalTransferredMinor &&
        compareTransfers(candidate.transfers, best.transfers) < 0
      ) {
        best = candidate;
      }
      return;
    }

    if (best && path.length >= best.transferCount) {
      return;
    }

    const debtor = currentDebtors[nextDebtorIndex];
    for (let creditIndex = 0; creditIndex < currentCreditors.length; creditIndex += 1) {
      if (exhaustedBudget) {
        return;
      }
      const creditor = currentCreditors[creditIndex];
      if (creditor.amountMinor <= 0) {
        continue;
      }

      const amountMinor = Math.min(debtor.amountMinor, creditor.amountMinor);
      const updatedDebtors = currentDebtors.map((entry) => ({ ...entry }));
      const updatedCreditors = currentCreditors.map((entry) => ({ ...entry }));

      updatedDebtors[nextDebtorIndex].amountMinor -= amountMinor;
      updatedCreditors[creditIndex].amountMinor -= amountMinor;

      path.push({
        fromMemberId: debtor.memberId,
        toMemberId: creditor.memberId,
        amountMinor,
      });

      search(updatedDebtors, updatedCreditors, path);
      path.pop();
    }
  };

  search(debtors, creditors, []);

  if (exhaustedBudget) {
    return {
      transfers: computeSimplifiedTransfers(ledgers),
      strategy: "simplified",
    };
  }

  const settled = best as SettlementResult | null;
  if (!settled) {
    return {
      transfers: [],
      strategy: "exact",
    };
  }
  return {
    transfers: settled.transfers,
    strategy: "exact",
  };
}
