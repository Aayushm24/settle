import { describe, expect, it } from "vitest";

import { validateUpload } from "@/lib/upload-validation";

function makeFile(name: string, type: string): File {
  return new File(["x"], name, { type });
}

describe("upload validation", () => {
  it("accepts matching MIME and extension", () => {
    const file = makeFile("statement.csv", "text/csv");
    expect(validateUpload(file, "statement")).toBeNull();
  });

  it("rejects mismatched extension even when MIME is allowed", () => {
    const file = makeFile("statement.txt", "text/csv");
    expect(validateUpload(file, "statement")).toBe("Unsupported file type.");
  });

  it("rejects mismatched MIME even when extension is allowed", () => {
    const file = makeFile("receipt.json", "text/plain");
    expect(validateUpload(file, "receipt")).toBe("Unsupported file type.");
  });

  it("allows extension-only fallback when browser MIME is empty", () => {
    const file = makeFile("receipt.txt", "");
    expect(validateUpload(file, "receipt")).toBeNull();
  });

  it("rejects unknown extension when MIME is empty", () => {
    const file = makeFile("receipt.exe", "");
    expect(validateUpload(file, "receipt")).toBe("Unsupported file type.");
  });
});
