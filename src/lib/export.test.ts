import { describe, expect, it } from "vitest";

import { buildSettlementCsv } from "@/lib/export";

describe("settlement export", () => {
  it("uses currency precision instead of fixed 2 decimals", () => {
    const csvIdr = buildSettlementCsv(
      "IDR",
      [{ id: "m1", name: "Member", active: true }],
      [{ memberId: "m1", paidMinor: 20200, owedMinor: 0, balanceMinor: 20200 }],
      [],
    );

    expect(csvIdr).toContain("20200");
    expect(csvIdr).not.toContain("20200.00");

    const csvBhd = buildSettlementCsv(
      "BHD",
      [{ id: "m1", name: "Member", active: true }],
      [{ memberId: "m1", paidMinor: 46553, owedMinor: 0, balanceMinor: 46553 }],
      [],
    );

    expect(csvBhd).toContain("46.553");
  });
});
