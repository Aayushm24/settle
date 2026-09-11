const CURRENCY_SCALE: Record<string, number> = {
  BHD: 3,
  IDR: 0,
  INR: 2,
  JPY: 0,
  KWD: 3,
  OMR: 3,
  USD: 2,
};

export function getCurrencyScale(currency: string): number {
  return CURRENCY_SCALE[currency.toUpperCase()] ?? 2;
}

export function toMinorUnits(value: number, currency: string): number {
  const scale = getCurrencyScale(currency);
  const factor = 10 ** scale;
  return Math.round(value * factor);
}

function isDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

function validateGroupedInteger(value: string, separator: "," | "."): boolean {
  const groups = value.split(separator);
  if (groups.length === 0) {
    return false;
  }

  if (!isDigits(groups[0]) || groups[0].length < 1 || groups[0].length > 3) {
    return false;
  }

  for (let index = 1; index < groups.length; index += 1) {
    const group = groups[index];
    if (!isDigits(group) || group.length !== 3) {
      return false;
    }
  }

  return true;
}

function normalizeAmount(raw: string, scale: number): { sign: number; integer: string; fraction: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Invalid amount: ${raw}`);
  }

  if (/[eE]/.test(trimmed)) {
    throw new Error(`Invalid amount: ${raw}`);
  }

  const sign = trimmed.startsWith("-") ? -1 : 1;
  const unsigned = trimmed.replace(/^[+-]/, "").replaceAll(/\s+/g, "");
  if (!/^[0-9][0-9.,]*$/.test(unsigned) || /^[.,]/.test(unsigned) || /[.,]$/.test(unsigned)) {
    throw new Error(`Invalid amount: ${raw}`);
  }

  const dotCount = unsigned.split(".").length - 1;
  const commaCount = unsigned.split(",").length - 1;

  let decimalSeparator: "." | "," | null = null;
  let groupingSeparator: "." | "," | null = null;

  if (dotCount > 0 && commaCount > 0) {
    const lastDot = unsigned.lastIndexOf(".");
    const lastComma = unsigned.lastIndexOf(",");
    decimalSeparator = lastDot > lastComma ? "." : ",";
    groupingSeparator = decimalSeparator === "." ? "," : ".";
  } else if (dotCount > 0 || commaCount > 0) {
    const separator = dotCount > 0 ? "." : ",";
    const count = separator === "." ? dotCount : commaCount;

    if (count > 1) {
      groupingSeparator = separator;
    } else {
      const split = unsigned.split(separator);
      if (split.length !== 2) {
        throw new Error(`Invalid amount: ${raw}`);
      }
      const left = split[0];
      const right = split[1];

      if (!isDigits(left) || !isDigits(right)) {
        throw new Error(`Invalid amount: ${raw}`);
      }

      if (scale > 0 && right.length <= scale) {
        decimalSeparator = separator;
      } else if (scale === 0 && /^0+$/.test(right)) {
        decimalSeparator = separator;
      } else if (right.length === 3) {
        if (separator === "," || scale === 0) {
          groupingSeparator = separator;
        } else {
          throw new Error(`Invalid amount: ${raw}`);
        }
      } else {
        throw new Error(`Invalid amount: ${raw}`);
      }
    }
  }

  let integerPart = unsigned;
  let fractionPart = "";

  if (decimalSeparator) {
    const split = unsigned.split(decimalSeparator);
    if (split.length !== 2) {
      throw new Error(`Invalid amount: ${raw}`);
    }
    integerPart = split[0];
    fractionPart = split[1];
  }

  if (groupingSeparator) {
    const groupedInteger = decimalSeparator ? integerPart : unsigned;

    if (!validateGroupedInteger(groupedInteger, groupingSeparator)) {
      throw new Error(`Invalid amount: ${raw}`);
    }
  }

  if (groupingSeparator) {
    integerPart = integerPart.split(groupingSeparator).join("");
  }

  if (!isDigits(integerPart)) {
    throw new Error(`Invalid amount: ${raw}`);
  }

  if (fractionPart && !isDigits(fractionPart)) {
    throw new Error(`Invalid amount: ${raw}`);
  }

  if (scale === 0) {
    if (fractionPart && !/^0+$/.test(fractionPart)) {
      throw new Error(`Invalid amount: ${raw}`);
    }
    fractionPart = "";
  } else if (fractionPart.length > scale) {
    throw new Error(`Invalid amount: ${raw}`);
  }

  return {
    sign,
    integer: integerPart,
    fraction: fractionPart,
  };
}

export function parseAmountToMinorUnits(raw: string, currency: string): number {
  const scale = getCurrencyScale(currency);
  const normalized = normalizeAmount(raw, scale);
  const paddedFraction = normalized.fraction.padEnd(scale, "0");
  const minorText = `${normalized.integer}${paddedFraction}`;
  if (!/^\d+$/.test(minorText)) {
    throw new Error(`Invalid amount: ${raw}`);
  }

  const minor = Number.parseInt(minorText, 10);
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`Amount is out of safe range: ${raw}`);
  }

  return minor * normalized.sign;
}

export function fromMinorUnits(minor: number, currency: string): number {
  const scale = getCurrencyScale(currency);
  const factor = 10 ** scale;
  return minor / factor;
}

export function formatMinorUnits(minor: number, currency: string): string {
  const scale = getCurrencyScale(currency);
  const value = fromMinorUnits(minor, currency);

  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).format(value);
}

export function formatMinorUnitsFixed(minor: number, currency: string): string {
  const scale = getCurrencyScale(currency);
  return fromMinorUnits(minor, currency).toFixed(scale);
}

export function convertMinorUnitsByRate(
  amountMinor: number,
  fromCurrency: string,
  toCurrency: string,
  settlementMajorPerOriginalMajor: number,
): number {
  if (!Number.isFinite(settlementMajorPerOriginalMajor) || settlementMajorPerOriginalMajor <= 0) {
    throw new Error("FX rate must be a positive number.");
  }

  const originalMajor = fromMinorUnits(amountMinor, fromCurrency);
  const settlementMajor = originalMajor * settlementMajorPerOriginalMajor;
  return toMinorUnits(settlementMajor, toCurrency);
}
