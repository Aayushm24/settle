import { describe, expect, it } from "vitest";

import { classifyExtractedText } from "@/lib/file-classification";

describe("classifyExtractedText", () => {
  it("classifies statement text from repeated DDMMYY rows", () => {
    const result = classifyExtractedText([
      "260826 Grab Ride INR 340.00",
      "270826 Team Dinner INR 1200.00",
      "280826 Ferry Booking INR 800.00",
    ].join("\n"));

    expect(result.kind).toBe("statement");
    expect(result.statementRowCount).toBe(3);
  });

  it("classifies receipt text from totals and booking markers", () => {
    const result = classifyExtractedText([
      "Receipt",
      "Booking ID: ZX-ALPHA-001",
      "Passenger: Mira",
      "Total Paid: INR 2340.00",
    ].join("\n"));

    expect(result.kind).toBe("receipt");
  });

  it("classifies receipt-like JSON metadata", () => {
    const result = classifyExtractedText(
      JSON.stringify({
        booking: "ZX-ALPHA-001",
        totalAmount: "INR 2340.00",
        passenger: "Mira",
      }),
    );

    expect(result.kind).toBe("receipt");
  });

  it("classifies DD/MM/YYYY rows as possible statement for recovery", () => {
    const result = classifyExtractedText([
      "26/08/2026 Ferry Terminal INR 340.00",
      "27/08/2026 Team Dinner INR 1200.00",
      "28/08/2026 Taxi INR 800.00",
    ].join("\n"));

    expect(result.kind).toBe("possible_statement");
    expect(result.possibleStatementRowCount).toBe(3);
  });

  it("returns unknown for unrelated text", () => {
    const result = classifyExtractedText("hello world");
    expect(result.kind).toBe("unknown");
  });
});
