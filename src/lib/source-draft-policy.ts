import { SourceDocumentDraft } from "@/lib/types";

export function isSourceDraftUnresolved(draft: SourceDocumentDraft): boolean {
  return draft.status === "needs_manual_review";
}

export function countUnresolvedSourceDrafts(drafts: SourceDocumentDraft[]): number {
  return drafts.filter(isSourceDraftUnresolved).length;
}
