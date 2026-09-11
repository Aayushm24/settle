import { describe, expect, it } from "vitest";

import { countUnresolvedSourceDrafts, isSourceDraftUnresolved } from "@/lib/source-draft-policy";
import { SourceDocumentDraft } from "@/lib/types";

function buildDraft(overrides: Partial<SourceDocumentDraft>): SourceDocumentDraft {
  return {
    id: "draft_1",
    name: "receipt.jpg",
    kind: "receipt",
    status: "needs_manual_review",
    reason: "Manual parse required",
    resolvedBy: null,
    resolvedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("source draft policy", () => {
  it("treats needs_manual_review drafts as unresolved", () => {
    expect(isSourceDraftUnresolved(buildDraft({ status: "needs_manual_review" }))).toBe(true);
  });

  it("does not treat resolved drafts as unresolved", () => {
    expect(
      isSourceDraftUnresolved(
        buildDraft({
          status: "resolved",
          resolvedBy: "member_1",
          resolvedAt: "2026-09-02T01:02:03.000Z",
        }),
      ),
    ).toBe(false);
  });

  it("counts only unresolved drafts as lock blockers", () => {
    const drafts: SourceDocumentDraft[] = [
      buildDraft({ id: "draft_a", status: "needs_manual_review" }),
      buildDraft({
        id: "draft_b",
        status: "resolved",
        resolvedBy: "member_2",
        resolvedAt: "2026-09-02T01:02:03.000Z",
      }),
      buildDraft({ id: "draft_c", status: "needs_manual_review" }),
    ];

    expect(countUnresolvedSourceDrafts(drafts)).toBe(2);
  });
});
