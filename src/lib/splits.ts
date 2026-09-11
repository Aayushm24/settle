import { ExpenseAllocation, SplitConfig, SplitMode } from "@/lib/types";

interface WeightedMember {
  memberId: string;
  weight: number;
}

function allocateByWeights(totalMinor: number, members: WeightedMember[]): ExpenseAllocation[] {
  if (members.length === 0) {
    return [];
  }

  const sign = totalMinor < 0 ? -1 : 1;
  const absoluteTotal = Math.abs(totalMinor);
  const weightSum = members.reduce((sum, member) => sum + member.weight, 0);
  if (weightSum <= 0) {
    throw new Error("Weight sum must be positive");
  }

  const base = members.map((member) => {
    const exact = (absoluteTotal * member.weight) / weightSum;
    const floor = Math.floor(exact);
    return {
      memberId: member.memberId,
      floor,
      remainder: exact - floor,
    };
  });

  const allocated = base.reduce((sum, entry) => sum + entry.floor, 0);
  let remainderUnits = absoluteTotal - allocated;

  const order = [...base].sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return right.remainder - left.remainder;
    }
    return left.memberId.localeCompare(right.memberId);
  });

  const result = new Map<string, number>();
  for (const entry of base) {
    result.set(entry.memberId, entry.floor);
  }

  for (const entry of order) {
    if (remainderUnits <= 0) {
      break;
    }
    result.set(entry.memberId, (result.get(entry.memberId) ?? 0) + 1);
    remainderUnits -= 1;
  }

  return members.map((member) => ({
    memberId: member.memberId,
    amountMinor: (result.get(member.memberId) ?? 0) * sign,
  }));
}

export function buildAllocations(
  totalMinor: number,
  splitMode: SplitMode,
  splitConfig: SplitConfig,
  payerId: string,
): ExpenseAllocation[] {
  const participants = splitConfig.participantIds;
  if (splitMode === "personal") {
    return [{ memberId: payerId, amountMinor: totalMinor }];
  }

  if (participants.length === 0) {
    throw new Error("At least one participant is required");
  }

  if (splitMode === "equal") {
    return allocateByWeights(
      totalMinor,
      participants.map((memberId) => ({ memberId, weight: 1 })),
    );
  }

  if (splitMode === "weighted") {
    return allocateByWeights(
      totalMinor,
      participants.map((memberId) => ({
        memberId,
        weight: splitConfig.weightByMemberId?.[memberId] ?? 1,
      })),
    );
  }

  if (splitMode === "exact") {
    const exacts = participants.map((memberId) => {
      const amount = splitConfig.exactAmountByMemberId?.[memberId] ?? 0;
      return {
        memberId,
        amountMinor: amount,
      };
    });

    const exactTotal = exacts.reduce((sum, entry) => sum + entry.amountMinor, 0);
    if (exactTotal !== totalMinor) {
      throw new Error("Exact split must equal total amount");
    }

    return exacts;
  }

  return [];
}
