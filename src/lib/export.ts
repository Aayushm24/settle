import { serializeCsv } from "@/lib/csv";
import { formatMinorUnitsFixed } from "@/lib/money";
import { Member, MemberLedger, Transfer } from "@/lib/types";

export function buildSettlementCsv(
  currency: string,
  members: Member[],
  ledgers: MemberLedger[],
  transfers: Transfer[],
): string {
  const memberName = new Map(members.map((member) => [member.id, member.name]));

  const ledgerRows = [
    ["Section", "Member", "Paid", "Share", "Net"],
    ...ledgers.map((ledger) => [
      "balances",
      memberName.get(ledger.memberId) ?? ledger.memberId,
      formatMinorUnitsFixed(ledger.paidMinor, currency),
      formatMinorUnitsFixed(ledger.owedMinor, currency),
      formatMinorUnitsFixed(ledger.balanceMinor, currency),
    ]),
  ];

  const transferRows = [
    ["Section", "From", "To", "Amount"],
    ...transfers.map((transfer) => [
      "transfers",
      memberName.get(transfer.fromMemberId) ?? transfer.fromMemberId,
      memberName.get(transfer.toMemberId) ?? transfer.toMemberId,
      formatMinorUnitsFixed(transfer.amountMinor, currency),
    ]),
  ];

  return serializeCsv([...ledgerRows, [], ...transferRows]);
}
