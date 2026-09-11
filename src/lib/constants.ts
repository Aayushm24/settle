import { FxRule } from "@/lib/types";

export const PILOT_START_DATE = "2026-08-23";
export const PILOT_END_DATE = "2026-09-02";

export const DEFAULT_SETTLEMENT_CURRENCY = "INR";
export const DEFAULT_FX_RULE: FxRule = "posted";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export const ALLOWED_STATEMENT_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const ALLOWED_RECEIPT_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "application/json",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
