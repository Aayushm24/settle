import { describe, expect, it } from "vitest";

import { parseReceiptText, suggestReceiptMatches } from "@/lib/receipt-matching";
import { parseStandardCharteredStatement } from "@/lib/statement-parser";

const STATEMENT_TEXT = `
260826 Transit Lane ZX-ALPHA IDR 20200.00 109.31
270826 Harbor Seats RIDE-7788 IDR 106500.00 574.36
300826 Arena Pass CLUB-331 IDR 156000.00 842.40
300826 SCB Ibanking Payment INR 3000.00
`;

describe("receipt matching", () => {
  const transactions = parseStandardCharteredStatement({
    text: STATEMENT_TEXT,
    sourceName: "statement.txt",
    uploaderId: "member_1",
    tripStartDate: "2026-08-23",
    tripEndDate: "2026-09-02",
  });

  it("matches by exact original amount and booking ID", () => {
    const receipt = parseReceiptText(
      [
        "Transit Lane",
        "Booking: ZX-ALPHA",
        "Total Paid: IDR 20,200.00",
        "Date 2026-08-26",
      ].join("\n"),
      "receipt.txt",
    );

    const suggestions = suggestReceiptMatches(receipt, transactions);
    expect(suggestions[0].confidence).toBe("high");
    const matchedTransaction = transactions.find((transaction) => transaction.id === suggestions[0].transactionId);
    expect(matchedTransaction?.merchant).toContain("Transit");
  });

  it("matches when receipt and statement are within three days", () => {
    const receipt = parseReceiptText(
      [
        "Harbor Seats",
        "Booking: RIDE-7788",
        "Paid: IDR106,500.00",
        "Date 2026-08-28",
      ].join("\n"),
      "receipt2.txt",
    );

    const suggestions = suggestReceiptMatches(receipt, transactions);
    expect(suggestions[0].evidence.join(" ").toLowerCase()).toContain("day");
    const matchedTransaction = transactions.find((transaction) => transaction.id === suggestions[0].transactionId);
    expect(matchedTransaction?.merchant).toContain("RIDE-7788");
  });

  it("parses labeled totals and prefers final total over first amount", () => {
    const receipt = parseReceiptText(
      [
        "Arena Pass",
        "Subtotal IDR 120,000.00",
        "Tax IDR 36,000.00",
        "Total Price IDR 156,000.00",
        "Paid IDR 156,000.00",
        "31 August 2026",
      ].join("\n"),
      "arena.txt",
    );

    expect(receipt.currency).toBe("IDR");
    expect(receipt.totalAmountMinor).toBe(156000);
    expect(receipt.date).toBe("2026-08-31");
  });

  it("parses Rp and RP amount formats used in receipts", () => {
    const small = parseReceiptText(["City Ride", "Total Paid: Rp20.200", "2026-08-24"].join("\n"), "r1.txt");
    const medium = parseReceiptText(
      ["Venue Ticket", "Paid: IDR156,000.00", "Aug 30, 2026"].join("\n"),
      "r2.txt",
    );
    const large = parseReceiptText(["Boat Charter", "Total payment RP 1.065.100", "2026-08-28"].join("\n"), "r3.txt");

    expect(small.totalAmountMinor).toBe(20200);
    expect(medium.totalAmountMinor).toBe(156000);
    expect(large.totalAmountMinor).toBe(1065100);
  });

  it("supports eligibility filter to exclude payment, excluded, or already-linked rows", () => {
    const receipt = parseReceiptText(
      ["Transit Lane", "Total Paid: IDR 20200", "Date 2026-08-26"].join("\n"),
      "eligible.txt",
    );
    const linkedId = transactions[0].id;

    const suggestions = suggestReceiptMatches(receipt, transactions, {
      isEligible: (transaction) =>
        transaction.inclusionState === "included" &&
        !transaction.isPayment &&
        transaction.id !== linkedId,
    });

    expect(suggestions.every((entry) => entry.transactionId !== linkedId)).toBe(true);
    expect(
      suggestions.every((entry) => {
        const transaction = transactions.find((row) => row.id === entry.transactionId);
        return transaction ? !transaction.isPayment && transaction.inclusionState === "included" : false;
      }),
    ).toBe(true);
  });
});
