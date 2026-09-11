import { describe, expect, it } from "vitest";

import { buildAllocations } from "@/lib/splits";

describe("split logic", () => {
  it("splits equally with deterministic remainder", () => {
    const allocations = buildAllocations(
      100,
      "equal",
      { participantIds: ["b", "a", "c"] },
      "a",
    );

    const amounts = Object.fromEntries(allocations.map((entry) => [entry.memberId, entry.amountMinor]));
    expect(amounts.a + amounts.b + amounts.c).toBe(100);
    expect(amounts.a).toBeGreaterThanOrEqual(amounts.b);
  });

  it("supports weighted split with integer rounding", () => {
    const allocations = buildAllocations(
      101,
      "weighted",
      {
        participantIds: ["a", "b"],
        weightByMemberId: { a: 1, b: 3 },
      },
      "a",
    );

    const map = Object.fromEntries(allocations.map((entry) => [entry.memberId, entry.amountMinor]));
    expect(map.a + map.b).toBe(101);
    expect(map.b).toBeGreaterThan(map.a);
  });

  it("requires exact split to equal total", () => {
    expect(() =>
      buildAllocations(
        100,
        "exact",
        {
          participantIds: ["a", "b"],
          exactAmountByMemberId: { a: 60, b: 30 },
        },
        "a",
      ),
    ).toThrowError();
  });

  it("keeps personal expense on payer only", () => {
    const allocations = buildAllocations(500, "personal", { participantIds: ["a", "b"] }, "a");
    expect(allocations).toEqual([{ memberId: "a", amountMinor: 500 }]);
  });
});
