export function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;

  const flushCell = () => {
    currentRow.push(currentCell);
    currentCell = "";
  };

  const flushRow = () => {
    rows.push(currentRow);
    currentRow = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const nextCharacter = input[index + 1];

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        currentCell += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && character === ",") {
      flushCell();
      continue;
    }

    if (!inQuotes && (character === "\n" || character === "\r")) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }
      flushCell();
      flushRow();
      continue;
    }

    currentCell += character;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    flushCell();
    flushRow();
  }

  return rows.filter((row) => row.some((cell) => cell.trim().length > 0));
}

export function sanitizeSpreadsheetText(value: string): string {
  const trimmed = value.trim();
  if (/^[=+\-@]/.test(trimmed)) {
    return `'${trimmed}`;
  }
  return trimmed;
}

export function toCsvValue(value: string): string {
  const safe = sanitizeSpreadsheetText(value);
  if (!/[",\n\r]/.test(safe)) {
    return safe;
  }

  return `"${safe.replaceAll('"', '""')}"`;
}

export function serializeCsv(rows: string[][]): string {
  return rows.map((row) => row.map(toCsvValue).join(",")).join("\n");
}
