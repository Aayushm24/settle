import {
  ALLOWED_RECEIPT_MIME_TYPES,
  ALLOWED_STATEMENT_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from "@/lib/constants";

const ALLOWED_EXTENSIONS = {
  statement: new Set(["csv", "txt", "pdf", "png", "jpg", "jpeg", "webp"]),
  receipt: new Set(["csv", "txt", "json", "pdf", "png", "jpg", "jpeg", "webp"]),
} as const;

const MIME_TO_EXTENSIONS: Record<string, Set<string>> = {
  "text/plain": new Set(["txt"]),
  "text/csv": new Set(["csv"]),
  "application/csv": new Set(["csv"]),
  "application/vnd.ms-excel": new Set(["csv"]),
  "application/json": new Set(["json"]),
  "application/pdf": new Set(["pdf"]),
  "image/png": new Set(["png"]),
  "image/jpeg": new Set(["jpg", "jpeg"]),
  "image/webp": new Set(["webp"]),
};

function extFromName(name: string): string {
  const bits = name.toLowerCase().split(".");
  return bits.length > 1 ? bits.at(-1) ?? "" : "";
}

export function validateUpload(file: File, kind: "statement" | "receipt"): string | null {
  if (file.size > MAX_UPLOAD_BYTES) {
    return `File exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit.`;
  }

  const extension = extFromName(file.name);
  const extensionAllowed = ALLOWED_EXTENSIONS[kind].has(extension);
  if (!extensionAllowed) {
    return "Unsupported file type.";
  }

  const mimeAllowed =
    kind === "statement"
      ? ALLOWED_STATEMENT_MIME_TYPES.has(file.type)
      : ALLOWED_RECEIPT_MIME_TYPES.has(file.type);

  if (!file.type) {
    return null;
  }

  if (!mimeAllowed) {
    return "Unsupported file type.";
  }

  const allowedExtensionsForMime = MIME_TO_EXTENSIONS[file.type];
  if (!allowedExtensionsForMime || !allowedExtensionsForMime.has(extension)) {
    return "Unsupported file type.";
  }

  return null;
}
