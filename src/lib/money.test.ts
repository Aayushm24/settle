import { describe, expect, it } from "vitest";

import { convertMinorUnitsByRate, parseAmountToMinorUnits } from "@/lib/money";

describe("money parsing", () => {
  it("parses grouped amounts exactly", () => {
    expect(parseAmountToMinorUnits("1,234.56", "INR")).toBe(123456);
    expect(parseAmountToMinorUnits("20.200", "IDR")).toBe(20200);
    expect(parseAmountToMinorUnits("1.065.100", "IDR")).toBe(1065100);
  });

  it("rejects malformed or partial amounts", () => {
    expect(() => parseAmountToMinorUnits("12abc", "INR")).toThrowError();
    expect(() => parseAmountToMinorUnits("1,23,456", "INR")).toThrowError();
    expect(() => parseAmountToMinorUnits("1e3", "INR")).toThrowError();
    expect(() => parseAmountToMinorUnits("100.999", "INR")).toThrowError();
    expect(() => parseAmountToMinorUnits("50.50", "IDR")).toThrowError();
  });
});

describe("fx conversion", () => {
  it("converts using major-unit rate from IDR to INR", () => {
    const settlementMinor = convertMinorUnitsByRate(20200, "IDR", "INR", 0.00541);
    expect(settlementMinor).toBe(10928);
  });

  it("supports 3-decimal settlement currencies", () => {
    const settlementMinor = convertMinorUnitsByRate(12345, "USD", "BHD", 0.3771);
    expect(settlementMinor).toBe(46553);
  });
});
