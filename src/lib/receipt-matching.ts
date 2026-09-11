import { dayDistance } from "@/lib/date";
import { stableHash } from "@/lib/id";
import { parseAmountToMinorUnits } from "@/lib/money";
import { Confidence, ReceiptEvidence, ReceiptMatchSuggestion, StatementTransaction } from "@/lib/types";

const ORDER_ID_PATTERN = /\b[A-Z]-[A-Z0-9]{6,}\b|\b(?:ORDER|BOOKING|TRIP)[-_ ]?[A-Z0-9]{4,}\b/gi;

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

interface ReceiptMatchOptions {
  isEligible?: (transaction: StatementTransaction) => boolean;
}

interface AmountCandidate {
  currency: string;
  amountRaw: string;
  lineIndex: number;
  index: number;
  labelScore: number;
}

export function extractBookingIds(input: string): string[] {
  const matches = input.match(ORDER_ID_PATTERN) ?? [];
  return [...new Set(matches.map((match) => match.toUpperCase()))];
}

function normalizeMerchant(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9 ]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function merchantSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalizeMerchant(a).split(" ").filter(Boolean));
  const tokensB = new Set(normalizeMerchant(b).split(" ").filter(Boolean));

  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }

  return intersection / (tokensA.size + tokensB.size - intersection);
}

function scoreToConfidence(score: number): Confidence {
  if (score >= 70) {
    return "high";
  }
  if (score >= 45) {
    return "medium";
  }
  return "low";
}

export function suggestReceiptMatches(
  receipt: ReceiptEvidence,
  transactions: StatementTransaction[],
  options: ReceiptMatchOptions = {},
): ReceiptMatchSuggestion[] {
  const suggestions: ReceiptMatchSuggestion[] = [];

  for (const transaction of transactions) {
    if (options.isEligible && !options.isEligible(transaction)) {
      continue;
    }

    const evidence: string[] = [];
    let score = 0;

    if (
      receipt.currency.toUpperCase() === transaction.originalCurrency.toUpperCase() &&
      receipt.totalAmountMinor === transaction.originalAmountMinor
    ) {
      score += 45;
      evidence.push("Exact original-currency amount match");
    }

    if (
      transaction.postedCurrency &&
      receipt.currency.toUpperCase() === transaction.postedCurrency.toUpperCase() &&
      receipt.totalAmountMinor === transaction.postedAmountMinor
    ) {
      score += 40;
      evidence.push("Exact posted-amount match");
    }

    if (receipt.date) {
      const days = dayDistance(receipt.date, transaction.date);
      if (days <= 3) {
        score += 20 - days * 4;
        evidence.push(`Dates are ${days} day(s) apart`);
      }
    }

    if (receipt.bookingIds.length > 0 && transaction.reference) {
      if (receipt.bookingIds.includes(transaction.reference.toUpperCase())) {
        score += 35;
        evidence.push("Booking/order ID match");
      }
    }

    const similarity = merchantSimilarity(receipt.merchant, transaction.merchant);
    if (similarity > 0.2) {
      score += Math.round(similarity * 20);
      evidence.push(`Merchant similarity ${(similarity * 100).toFixed(0)}%`);
    }

    if (score <= 0) {
      continue;
    }

    suggestions.push({
      transactionId: transaction.id,
      score,
      confidence: scoreToConfidence(score),
      evidence,
    });
  }

  return suggestions.sort((left, right) => right.score - left.score);
}

function normalizeCurrency(raw: string): string {
  const upper = raw.toUpperCase();
  if (upper === "RP") {
    return "IDR";
  }
  return upper;
}

function scoreAmountLabel(line: string): number {
  const normalized = line.toLowerCase();
  let score = 0;

  if (/total\s*paid/.test(normalized)) {
    score = Math.max(score, 6);
  }
  if (/total\s*payment/.test(normalized)) {
    score = Math.max(score, 5);
  }
  if (/total\s*price/.test(normalized)) {
    score = Math.max(score, 4);
  }
  if (/\bpaid\b/.test(normalized)) {
    score = Math.max(score, 3);
  }
  if (/\btotal\b/.test(normalized)) {
    score = Math.max(score, 2);
  }
  if (/(taxes\s*included|incl\.?\s*tax)/.test(normalized)) {
    score += 1;
  }

  return score;
}

function extractAmountsByLine(lines: string[]): AmountCandidate[] {
  const candidates: AmountCandidate[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const labelScore = scoreAmountLabel(line);
    const regex = /\b([A-Z]{3}|RP)\s*([0-9][0-9.,]*)\b/gi;
    for (const match of line.matchAll(regex)) {
      candidates.push({
        currency: normalizeCurrency(match[1]),
        amountRaw: match[2],
        lineIndex,
        index: match.index ?? 0,
        labelScore,
      });
    }
  }

  return candidates;
}

function normalizeIsoDate(year: number, month: number, day: number): string | null {
  const iso = `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  const candidate = new Date(`${iso}T00:00:00Z`);
  if (
    Number.isNaN(candidate.getTime()) ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return iso;
}

function parseReceiptDate(text: string): string | null {
  const isoLike = text.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (isoLike) {
    const year = Number.parseInt(isoLike[1], 10);
    const month = Number.parseInt(isoLike[2], 10);
    const day = Number.parseInt(isoLike[3], 10);
    const iso = normalizeIsoDate(year, month, day);
    if (iso) {
      return iso;
    }
  }

  const dayFirst = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s*,?\s*(20\d{2})\b/);
  if (dayFirst) {
    const day = Number.parseInt(dayFirst[1], 10);
    const month = MONTHS[dayFirst[2].toLowerCase()];
    const year = Number.parseInt(dayFirst[3], 10);
    if (month) {
      const iso = normalizeIsoDate(year, month, day);
      if (iso) {
        return iso;
      }
    }
  }

  const monthFirst = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s*(20\d{2})\b/);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    const day = Number.parseInt(monthFirst[2], 10);
    const year = Number.parseInt(monthFirst[3], 10);
    if (month) {
      const iso = normalizeIsoDate(year, month, day);
      if (iso) {
        return iso;
      }
    }
  }

  return null;
}

function pickBestAmount(candidates: AmountCandidate[]): AmountCandidate | null {
  if (candidates.length === 0) {
    return null;
  }

  const labeled = candidates.filter((candidate) => candidate.labelScore > 0);
  const pool = labeled.length > 0 ? labeled : candidates;

  return [...pool].sort((left, right) => {
    if (right.labelScore !== left.labelScore) {
      return right.labelScore - left.labelScore;
    }
    if (right.lineIndex !== left.lineIndex) {
      return right.lineIndex - left.lineIndex;
    }
    return right.index - left.index;
  })[0];
}

export function parseReceiptText(text: string, sourceName: string): ReceiptEvidence {
  const upper = text.toUpperCase();
  const bookingIds = extractBookingIds(upper);

  const date = parseReceiptDate(text);
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const amountCandidate = pickBestAmount(extractAmountsByLine(lines));

  let currency = "INR";
  let totalAmountMinor = 0;

  if (amountCandidate) {
    currency = amountCandidate.currency;
    totalAmountMinor = parseAmountToMinorUnits(amountCandidate.amountRaw, currency);
  }

  const merchantLine =
    lines.find(
      (line) =>
        line.length > 0 &&
        !line.includes(":") &&
        !/^(date|paid|total|booking|order|trip id|receipt no)\b/i.test(line),
    ) ?? sourceName;

  const passengerMatch = text.match(/passenger\s*[:=-]\s*([^\n\r]+)/i);
  const profileMatch = text.match(/profile\s*[:=-]\s*([^\n\r]+)/i);
  const serviceMatch = text.match(/service\s*[:=-]\s*([^\n\r]+)/i);

  return {
    id: `receipt_${stableHash(`${sourceName}:${text}`)}`,
    sourceId: `source_${stableHash(sourceName)}`,
    sourceName,
    date,
    merchant: merchantLine,
    totalAmountMinor,
    currency,
    bookingIds,
    passengerName: passengerMatch?.[1]?.trim() ?? null,
    profile: profileMatch?.[1]?.trim() ?? null,
    service: serviceMatch?.[1]?.trim() ?? null,
    text,
    createdAt: new Date().toISOString(),
  };
}
