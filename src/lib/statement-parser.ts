import { isInclusiveDateInRange, parseDdMmYy } from "@/lib/date";
import { sanitizeSpreadsheetText } from "@/lib/csv";
import { stableHash } from "@/lib/id";
import { parseAmountToMinorUnits } from "@/lib/money";
import { StatementTransaction } from "@/lib/types";

interface ParseStatementParams {
  text: string;
  sourceName: string;
  uploaderId: string;
  tripStartDate: string;
  tripEndDate: string;
}

interface ParsedStatementRow {
  date: string;
  merchant: string;
  originalCurrency: string;
  originalAmountMinor: number;
  postedCurrency: string | null;
  postedAmountMinor: number | null;
  isCredit: boolean;
  isPayment: boolean;
  isFeeOrTax: boolean;
  reference: string | null;
  rawText: string;
}

const START_PATTERN = /^(\d{6})(?:\s+|,)(.+)$/;

interface CurrencyAmountToken {
  currency: string;
  amountRaw: string;
  index: number;
  full: string;
}

interface NumericToken {
  amountRaw: string;
  index: number;
}

function extractReference(text: string): string | null {
  const match = text.match(/\b[A-Z]-[A-Z0-9]{6,}\b/i);
  return match ? match[0].toUpperCase() : null;
}

function parseRow(rawRow: string): ParsedStatementRow | null {
  const match = START_PATTERN.exec(rawRow.trim());
  if (!match) {
    return null;
  }

  const ddmmyy = match[1];
  const payload = match[2].replaceAll(/\s+/g, " ").trim();
  const payloadWithoutCredit = payload.replace(/\bCR\b/gi, "").replaceAll(/\s+/g, " ").trim();
  const date = parseDdMmYy(ddmmyy);

  const hasCreditMarker = /\bCR\b/i.test(payload);
  const isPayment = /scb\s+ibanking\s+payment/i.test(payload);
  const isFeeOrTax = /(forex markup fee|\bcgst\b|\bsgst\b|igst|service tax)/i.test(payload);

  const amountTokens: CurrencyAmountToken[] = [...payloadWithoutCredit.matchAll(
    /\b([A-Z]{3})\s*([0-9][0-9,]*(?:\.[0-9]+)?)\b/gi,
  )].map(
    (token) => ({
      currency: token[1].toUpperCase(),
      amountRaw: token[2],
      index: token.index ?? 0,
      full: token[0],
    }),
  );

  const bareAmountTokens: NumericToken[] = [...payloadWithoutCredit.matchAll(/\b([0-9][0-9,]*(?:\.[0-9]+)?)\b/g)].map(
    (token) => ({
      amountRaw: token[1],
      index: token.index ?? 0,
    }),
  );

  if (amountTokens.length === 0 && bareAmountTokens.length === 0) {
    return null;
  }

  const inrToken = [...amountTokens].reverse().find((token) => token.currency === "INR") ?? null;
  const originalToken =
    [...amountTokens].reverse().find((token) => token.currency !== "INR") ??
    amountTokens[0] ??
    null;

  let originalCurrency = "INR";
  let originalAmountRaw = "";
  let postedCurrency: string | null = null;
  let postedAmountRaw: string | null = null;
  let merchantEndAt = payloadWithoutCredit.length;

  if (originalToken) {
    originalCurrency = originalToken.currency;
    originalAmountRaw = originalToken.amountRaw;
    merchantEndAt = Math.min(merchantEndAt, originalToken.index);

    if (inrToken && inrToken.index !== originalToken.index) {
      postedCurrency = "INR";
      postedAmountRaw = inrToken.amountRaw;
    } else if (inrToken && inrToken.index === originalToken.index && originalToken.currency === "INR") {
      postedCurrency = "INR";
      postedAmountRaw = inrToken.amountRaw;
    } else {
      const originalEnd = originalToken.index + originalToken.full.length;
      const trailingBare = bareAmountTokens.filter((token) => token.index >= originalEnd);
      const postedBare = trailingBare.at(-1) ?? null;
      if (postedBare) {
        postedCurrency = "INR";
        postedAmountRaw = postedBare.amountRaw;
      }
    }
  } else {
    const postedBare = bareAmountTokens.at(-1) ?? null;
    if (!postedBare) {
      return null;
    }
    originalCurrency = "INR";
    originalAmountRaw = postedBare.amountRaw;
    postedCurrency = "INR";
    postedAmountRaw = postedBare.amountRaw;

    if (bareAmountTokens.length >= 2 && bareAmountTokens[bareAmountTokens.length - 2].amountRaw === "0") {
      merchantEndAt = bareAmountTokens[bareAmountTokens.length - 2].index;
    } else {
      merchantEndAt = postedBare.index;
    }
  }

  if (!originalAmountRaw) {
    return null;
  }

  const originalAmountMinor = parseAmountToMinorUnits(originalAmountRaw, originalCurrency);
  const postedAmountMinor =
    postedAmountRaw && postedCurrency ? parseAmountToMinorUnits(postedAmountRaw, postedCurrency) : null;

  const sign = hasCreditMarker ? -1 : 1;
  const merchant =
    sanitizeSpreadsheetText(payloadWithoutCredit.slice(0, merchantEndAt).replaceAll(/[,;]+$/g, "").trim()) ||
    "Unknown merchant";

  return {
    date,
    merchant,
    originalCurrency,
    originalAmountMinor: originalAmountMinor * sign,
    postedCurrency,
    postedAmountMinor: postedAmountMinor === null ? null : postedAmountMinor * sign,
    isCredit: hasCreditMarker,
    isPayment,
    isFeeOrTax,
    reference: extractReference(payload),
    rawText: rawRow,
  };
}

function groupWrappedRows(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const grouped: string[] = [];
  let current = "";

  for (const line of lines) {
    if (START_PATTERN.test(line)) {
      if (current) {
        grouped.push(current);
      }
      current = line;
      continue;
    }

    if (!current) {
      continue;
    }
    current = `${current} ${line}`;
  }

  if (current) {
    grouped.push(current);
  }

  return grouped;
}

export function parseStandardCharteredStatement({
  text,
  sourceName,
  uploaderId,
  tripStartDate,
  tripEndDate,
}: ParseStatementParams): StatementTransaction[] {
  const groupedRows = groupWrappedRows(text);
  const transactions: StatementTransaction[] = [];

  for (const row of groupedRows) {
    const parsed = parseRow(row);
    if (!parsed) {
      continue;
    }

    if (!isInclusiveDateInRange(parsed.date, tripStartDate, tripEndDate)) {
      continue;
    }

    const fingerprintSeed = [
      parsed.date,
      parsed.merchant.toLowerCase(),
      parsed.originalCurrency,
      parsed.originalAmountMinor.toString(),
      parsed.reference ?? "",
    ].join("|");

    transactions.push({
      id: `txn_${stableHash(`${sourceName}:${row}`)}`,
      sourceId: `src_${stableHash(sourceName)}`,
      sourceName,
      uploaderId,
      date: parsed.date,
      merchant: parsed.merchant,
      originalAmountMinor: parsed.originalAmountMinor,
      originalCurrency: parsed.originalCurrency,
      postedAmountMinor: parsed.postedAmountMinor,
      postedCurrency: parsed.postedCurrency,
      inclusionState: parsed.isPayment ? "excluded" : "included",
      isCredit: parsed.isCredit,
      isPayment: parsed.isPayment,
      isFeeOrTax: parsed.isFeeOrTax,
      fingerprint: stableHash(fingerprintSeed),
      reference: parsed.reference,
      rawText: parsed.rawText,
      createdAt: new Date().toISOString(),
    });
  }

  return transactions;
}
