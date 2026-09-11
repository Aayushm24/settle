import { LikelyPersonalFlag, ReceiptEvidence } from "@/lib/types";

interface PersonalSignalInput {
  merchant: string;
  description?: string;
  receipt?: ReceiptEvidence | null;
  confirmedPersonalPatterns?: string[];
}

function includesKeyword(value: string, keywords: string[]): boolean {
  const normalized = value.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

export function detectLikelyPersonalExpense(input: PersonalSignalInput): LikelyPersonalFlag {
  const reasons: string[] = [];
  let score = 0;

  const merchant = input.merchant.toLowerCase();
  const description = input.description?.toLowerCase() ?? "";
  const receiptService = input.receipt?.service?.toLowerCase() ?? "";

  if (input.receipt?.passengerName) {
    score += 3;
    reasons.push("Receipt includes a named passenger");
  }

  if (input.receipt?.profile?.toLowerCase() === "personal") {
    score += 3;
    reasons.push("Receipt explicitly marks profile PERSONAL");
  }

  if (includesKeyword(receiptService, ["grabbike", "bike"])) {
    score += 2;
    reasons.push("Service appears to be a single-rider bike trip");
  }

  if (
    includesKeyword(`${merchant} ${description}`, [
      "ticket",
      "lesson",
      "registrant",
      "admission",
      "single guest",
      "one seat",
    ])
  ) {
    score += 2;
    reasons.push("Evidence suggests a single-person booking");
  }

  if (includesKeyword(`${merchant} ${description}`, ["single registrant", "one registrant", "single ticket"])) {
    score += 2;
    reasons.push("Explicit single-person language found in evidence");
  }

  if (
    includesKeyword(`${merchant} ${description}`, [
      "salon",
      "spa",
      "barber",
      "grooming",
      "skincare",
      "cosmetic",
      "pharmacy",
    ])
  ) {
    score += 2;
    reasons.push("Merchant category resembles personal care");
  }

  if (includesKeyword(`${merchant} ${description}`, ["subscription", "membership", "monthly pass"])) {
    score += 2;
    reasons.push("Charge looks like an individual subscription");
  }

  const patterns = input.confirmedPersonalPatterns ?? [];
  for (const pattern of patterns) {
    const normalized = pattern.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (merchant.includes(normalized) || description.includes(normalized)) {
      score += 2;
      reasons.push(`Matched a group-confirmed personal pattern: ${pattern}`);
      break;
    }
  }

  const likely = score >= 3;
  let confidence: LikelyPersonalFlag["confidence"] = "low";

  if (score >= 6) {
    confidence = "high";
  } else if (score >= 3) {
    confidence = "medium";
  }

  return {
    likely,
    confidence,
    reasons,
  };
}
