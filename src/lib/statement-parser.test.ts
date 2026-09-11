import { describe, expect, it } from "vitest";

import { parseStandardCharteredStatement } from "@/lib/statement-parser";

const SAMPLE = `
220826 Outside Window Merchant IDR 11100.00 60.00
230826 Transit Lane ZX-ALPHA 741923 2 001 IDR 20200.00 109.31
240826 Harbor Meals HBR-444 555111 3 002 IDR 106510.00 574.36
250826 Studio Court Booking BOOKING-AB12CD 156000.00 INR 842.40
260826 SCB Ibanking Payment INR 3000.00
270826 Forex Markup Fee Retail 0 175.99
270826 CGST 0 15.84
280826 SGST 0 15.84
290826 Wrapped Merchant Segment One
Segment Two 993321 2 009 IDR 10000.00 54.00
300826 Refund Sample REF-778899 IDR 5000.00 27.00 CR
020926 End Window Merchant IDR 7500.00 40.50
030926 Outside End Merchant IDR 9000.00 48.60
`;

describe("Standard Chartered parser", () => {
  it("parses DDMMYY rows and enforces inclusive date filters", () => {
    const rows = parseStandardCharteredStatement({
      text: SAMPLE,
      sourceName: "sample.txt",
      uploaderId: "member_1",
      tripStartDate: "2026-08-23",
      tripEndDate: "2026-09-02",
    });

    expect(rows.some((row) => row.date === "2026-08-22")).toBe(false);
    expect(rows.some((row) => row.date === "2026-09-03")).toBe(false);
    expect(rows.some((row) => row.date === "2026-08-23")).toBe(true);
    expect(rows.some((row) => row.date === "2026-09-02")).toBe(true);
  });

  it("supports extracted-table rows with trailing posted INR and no INR token", () => {
    const rows = parseStandardCharteredStatement({
      text: SAMPLE,
      sourceName: "sample.txt",
      uploaderId: "member_1",
      tripStartDate: "2026-08-23",
      tripEndDate: "2026-09-02",
    });

    const transit = rows.find((row) => row.merchant.includes("Transit Lane"));
    expect(transit?.originalCurrency).toBe("IDR");
    expect(transit?.originalAmountMinor).toBe(20200);
    expect(transit?.postedCurrency).toBe("INR");
    expect(transit?.postedAmountMinor).toBe(10931);
  });

  it("marks payment rows excluded and credits negative", () => {
    const rows = parseStandardCharteredStatement({
      text: SAMPLE,
      sourceName: "sample.txt",
      uploaderId: "member_1",
      tripStartDate: "2026-08-23",
      tripEndDate: "2026-09-02",
    });

    const payment = rows.find((row) => row.merchant.toLowerCase().includes("ibanking payment"));
    expect(payment?.isPayment).toBe(true);
    expect(payment?.inclusionState).toBe("excluded");

    const credit = rows.find((row) => row.merchant.toLowerCase().includes("refund sample"));
    expect(credit?.isCredit).toBe(true);
    expect((credit?.originalAmountMinor ?? 0) < 0).toBe(true);
    expect((credit?.postedAmountMinor ?? 0) < 0).toBe(true);
  });

  it("keeps fee and tax rows reviewable when rows include type and rewards columns", () => {
    const rows = parseStandardCharteredStatement({
      text: SAMPLE,
      sourceName: "sample.txt",
      uploaderId: "member_1",
      tripStartDate: "2026-08-23",
      tripEndDate: "2026-09-02",
    });

    expect(
      rows.some(
        (row) =>
          row.isFeeOrTax &&
          row.merchant.toLowerCase().includes("forex markup fee retail") &&
          row.postedAmountMinor === 17599,
      ),
    ).toBe(true);
    expect(rows.some((row) => row.isFeeOrTax && row.merchant.toLowerCase().includes("cgst"))).toBe(true);
    expect(rows.some((row) => row.isFeeOrTax && row.merchant.toLowerCase().includes("sgst"))).toBe(true);
  });

  it("creates distinct fingerprints for same-amount rows using more than amount", () => {
    const duplicatedAmountInput = `
260826 Merchant Alpha CODE-AX11 IDR 20000.00 108.00
260826 Merchant Beta CODE-BY22 IDR 20000.00 108.00
`;

    const rows = parseStandardCharteredStatement({
      text: duplicatedAmountInput,
      sourceName: "dupes.txt",
      uploaderId: "member_1",
      tripStartDate: "2026-08-23",
      tripEndDate: "2026-09-02",
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].fingerprint).not.toBe(rows[1].fingerprint);
  });

  it("parses CSV-style DDMMYY rows", () => {
    const rows = parseStandardCharteredStatement({
      text: "260826,Transit Lane ZX-ALPHA,IDR 20200.00,109.31",
      sourceName: "statement.csv",
      uploaderId: "member_1",
      tripStartDate: "2026-08-23",
      tripEndDate: "2026-09-02",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].merchant).toContain("Transit Lane");
    expect(rows[0].postedAmountMinor).toBe(10931);
  });
});
