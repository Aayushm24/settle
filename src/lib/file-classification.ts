export type ClassifiedDocumentKind = "statement" | "possible_statement" | "receipt" | "unknown";

export interface FileClassificationResult {
  kind: ClassifiedDocumentKind;
  reason: string;
  statementRowCount: number;
  possibleStatementRowCount: number;
  receiptSignalCount: number;
}

const STATEMENT_ROW_PATTERN = /^\s*\d{6}(?:\s+|,).+$/gm;
const POSSIBLE_STATEMENT_ROW_PATTERN =
  /^\s*(?:\d{1,2}\/\d{1,2}\/\d{4}|20\d{2}-\d{1,2}-\d{1,2})(?:\s+|,).+$/gm;

const RECEIPT_SIGNAL_PATTERNS = [
  /\btotal\b/i,
  /\bpaid\b/i,
  /\breceipt\b/i,
  /\bbooking\b/i,
  /\border\b/i,
  /\bpassenger\b/i,
  /\bprofile\b/i,
  /\bservice\b/i,
  /\binvoice\b/i,
];

const CURRENCY_AMOUNT_PATTERN =
  /\b(?:INR|IDR|USD|SGD|EUR|GBP|AED|RP)\s*[0-9][0-9,]*(?:\.[0-9]+)?\b/i;

function countMatches(pattern: RegExp, input: string): number {
  const matches = input.match(pattern);
  return matches ? matches.length : 0;
}

function countReceiptSignals(input: string): number {
  let score = 0;
  for (const pattern of RECEIPT_SIGNAL_PATTERNS) {
    if (pattern.test(input)) {
      score += 1;
    }
  }
  return score;
}

function looksLikeStructuredReceiptJson(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const serialized = JSON.stringify(parsed).toLowerCase();
    return /(booking|order|passenger|receipt|total|amount)/.test(serialized);
  } catch {
    return false;
  }
}

export function classifyExtractedText(text: string): FileClassificationResult {
  const normalized = text.trim();
  if (!normalized) {
    return {
      kind: "unknown",
      reason: "No readable text found.",
      statementRowCount: 0,
      possibleStatementRowCount: 0,
      receiptSignalCount: 0,
    };
  }

  const statementRowCount = countMatches(STATEMENT_ROW_PATTERN, normalized);
  const possibleStatementRowCount = countMatches(POSSIBLE_STATEMENT_ROW_PATTERN, normalized);
  const receiptSignalCount = countReceiptSignals(normalized);
  const hasCurrencyAmount = CURRENCY_AMOUNT_PATTERN.test(normalized);
  const hasBookingOrPassenger = /(booking|order|passenger|profile)/i.test(normalized);

  if (statementRowCount >= 3) {
    return {
      kind: "statement",
      reason: `Found ${statementRowCount} DDMMYY-style transaction rows.`,
      statementRowCount,
      possibleStatementRowCount,
      receiptSignalCount,
    };
  }

  if (statementRowCount >= 2 && receiptSignalCount <= 1) {
    return {
      kind: "statement",
      reason: "Rows are strongly formatted like statement lines.",
      statementRowCount,
      possibleStatementRowCount,
      receiptSignalCount,
    };
  }

  if (possibleStatementRowCount >= 2 && receiptSignalCount <= 1) {
    return {
      kind: "possible_statement",
      reason:
        "Rows look like statement entries with date prefixes, but not in the Standard Chartered DDMMYY pilot format.",
      statementRowCount,
      possibleStatementRowCount,
      receiptSignalCount,
    };
  }

  if (looksLikeStructuredReceiptJson(normalized)) {
    return {
      kind: "receipt",
      reason: "Structured JSON fields look like receipt metadata.",
      statementRowCount,
      possibleStatementRowCount,
      receiptSignalCount,
    };
  }

  if ((receiptSignalCount >= 2 && hasCurrencyAmount) || (hasBookingOrPassenger && hasCurrencyAmount)) {
    return {
      kind: "receipt",
      reason: "Contains receipt-like totals and booking/passenger markers.",
      statementRowCount,
      possibleStatementRowCount,
      receiptSignalCount,
    };
  }

  return {
    kind: "unknown",
    reason: "Could not classify confidently from extracted structure.",
    statementRowCount,
    possibleStatementRowCount,
    receiptSignalCount,
  };
}
