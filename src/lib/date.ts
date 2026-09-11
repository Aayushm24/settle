const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertValidDateParts(year: number, month: number, day: number, raw: string): void {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Invalid date: ${raw}`);
  }

  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date: ${raw}`);
  }
}

export function parseIsoDate(date: string): Date {
  const match = DATE_PATTERN.exec(date);
  if (!match) {
    throw new Error(`Invalid ISO date: ${date}`);
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  assertValidDateParts(year, month, day, date);

  return new Date(Date.UTC(year, month - 1, day));
}

export function parseDdMmYy(date: string): string {
  const cleaned = date.trim();
  if (!/^\d{6}$/.test(cleaned)) {
    throw new Error(`Invalid DDMMYY date: ${date}`);
  }

  const day = Number.parseInt(cleaned.slice(0, 2), 10);
  const month = Number.parseInt(cleaned.slice(2, 4), 10);
  const year = 2000 + Number.parseInt(cleaned.slice(4, 6), 10);

  assertValidDateParts(year, month, day, date);

  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function isInclusiveDateInRange(
  date: string,
  startDate: string,
  endDate: string,
): boolean {
  const value = parseIsoDate(date).getTime();
  const start = parseIsoDate(startDate).getTime();
  const end = parseIsoDate(endDate).getTime();
  return value >= start && value <= end;
}

export function dayDistance(a: string, b: string): number {
  const left = parseIsoDate(a).getTime();
  const right = parseIsoDate(b).getTime();
  return Math.round(Math.abs(left - right) / (1000 * 60 * 60 * 24));
}
