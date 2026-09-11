import { describe, expect, it } from "vitest";

import { isInclusiveDateInRange, parseDdMmYy, parseIsoDate } from "@/lib/date";

describe("date utilities", () => {
  it("parses DDMMYY into ISO date", () => {
    expect(parseDdMmYy("260826")).toBe("2026-08-26");
  });

  it("uses inclusive date boundaries", () => {
    const start = "2026-08-23";
    const end = "2026-09-02";

    expect(isInclusiveDateInRange("2026-08-23", start, end)).toBe(true);
    expect(isInclusiveDateInRange("2026-09-02", start, end)).toBe(true);
    expect(isInclusiveDateInRange("2026-08-22", start, end)).toBe(false);
    expect(isInclusiveDateInRange("2026-09-03", start, end)).toBe(false);
  });

  it("rejects impossible DDMMYY and ISO calendar dates", () => {
    expect(() => parseDdMmYy("320826")).toThrowError();
    expect(() => parseDdMmYy("310226")).toThrowError();
    expect(() => parseIsoDate("2026-02-30")).toThrowError();
    expect(() => parseIsoDate("2026-13-01")).toThrowError();
  });
});
