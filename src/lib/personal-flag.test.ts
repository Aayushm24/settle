import { describe, expect, it } from "vitest";

import { detectLikelyPersonalExpense } from "@/lib/personal-flag";
import { parseReceiptText } from "@/lib/receipt-matching";

describe("likely personal detection", () => {
  it("flags bike receipt as likely personal", () => {
    const receipt = parseReceiptText(
      [
        "Ride Receipt",
        "Passenger: Member Alpha",
        "Profile: PERSONAL",
        "Service: Bike",
        "Total Paid: IDR 20,200.00",
        "Picked up: 2026-08-26",
      ].join("\n"),
      "grab-bike.txt",
    );

    const result = detectLikelyPersonalExpense({
      merchant: "Ride Service ZX-ALPHA",
      description: "Ride",
      receipt,
    });

    expect(result.likely).toBe(true);
    expect(["medium", "high"]).toContain(result.confidence);
  });

  it("does not mark six-seater group car as personal by capacity", () => {
    const receipt = parseReceiptText(
      [
        "Transport Receipt",
        "Service: GroupCar Plus 6 Seater",
        "Total Paid: IDR 106,500.00",
        "Date: 2026-08-28",
      ].join("\n"),
      "grab-car.txt",
    );

    const result = detectLikelyPersonalExpense({
      merchant: "Transport RIDE-7788",
      description: "Airport transfer",
      receipt,
    });

    expect(result.likely).toBe(false);
  });

  it("flags single-registrant activity as likely personal", () => {
    const receipt = parseReceiptText(
      [
        "Arena Pass",
        "One registrant",
        "IDR 156,000.00",
        "2026-08-30",
      ].join("\n"),
      "playtomic.txt",
    );

    const result = detectLikelyPersonalExpense({
      merchant: "Arena Pass",
      description: "single registrant ticket",
      receipt,
    });

    expect(result.likely).toBe(true);
  });
});
