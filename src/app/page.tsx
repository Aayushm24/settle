"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ExpenseEditor } from "@/components/expense-editor";
import { parseTransactionCommand, TransactionCommand } from "@/lib/command-parser";
import {
  classifyExtractedText,
  ClassifiedDocumentKind,
  FileClassificationResult,
} from "@/lib/file-classification";
import { extractDocumentText } from "@/lib/document-extraction";
import { resolveSettlementAmountFromTransaction } from "@/lib/fx";
import { makeId } from "@/lib/id";
import { formatMinorUnits } from "@/lib/money";
import { suggestReceiptMatches } from "@/lib/receipt-matching";
import {
  buildUnapprovedTransactionIdSet,
  buildApprovedTransactionIdSet,
  computeReviewProgress,
  isTransactionReviewed,
} from "@/lib/review-progress";
import { validateUpload } from "@/lib/upload-validation";
import { useSettle } from "@/lib/use-settle";
import {
  Expense,
  ExpenseComment,
  Member,
  ReceiptEvidence,
  StatementTransaction,
  Transfer,
} from "@/lib/types";
import {
  DEFAULT_FX_RULE,
  DEFAULT_SETTLEMENT_CURRENCY,
  PILOT_END_DATE,
  PILOT_START_DATE,
} from "@/lib/constants";

type UploadStatus =
  | "queued"
  | "reading"
  | "extracted"
  | "imported"
  | "receipt_added"
  | "needs_help"
  | "failed";

type UploadKind = "statement" | "receipt";

interface UploadQueueItem {
  id: string;
  batchId: string;
  file: File;
  fileName: string;
  mimeType: string;
  status: UploadStatus;
  detectedKind: ClassifiedDocumentKind;
  classification: FileClassificationResult | null;
  overrideKind: UploadKind | null;
  extractedText: string;
  warning: string | null;
  message: string;
  importedCount: number;
  duplicateCount: number;
  sourceDraftId: string | null;
}

interface SetupFormState {
  creatorName: string;
  tripName: string;
  startDate: string;
  endDate: string;
  settlementCurrency: string;
  friendNamesText: string;
}

interface SetupFieldErrors {
  creatorName?: string;
  tripName?: string;
  friendNamesText?: string;
}

interface PendingCommandPreview {
  transactionId: string;
  command: TransactionCommand;
  before: string;
  after: string;
}

interface ReviewCardModel {
  transaction: StatementTransaction;
  expense: Expense | null;
  reviewed: boolean;
  confidence: "low" | "medium" | "high";
  confidenceReasons: string[];
  suggestedReceipt: {
    receiptId: string;
    score: number;
    confidence: "low" | "medium" | "high";
    evidence: string[];
  } | null;
  impactMinor: number;
  uncertaintyRank: number;
}

interface PendingUndoAction {
  kind: "approve" | "exclude";
  label: string;
  expiresAt: number;
  expenseId?: string;
  transactionId?: string;
  restoreExpense?: Expense | null;
  restoreComments?: ExpenseComment[];
}

function memberName(members: Member[], memberId: string | null): string {
  if (!memberId) {
    return "Unknown";
  }
  return members.find((member) => member.id === memberId)?.name ?? memberId;
}

function splitLabel(expense: Expense, members: Member[]): string {
  const names = expense.splitConfig.participantIds.map((id) => memberName(members, id));
  if (expense.splitMode === "personal") {
    return `Personal · ${names.join(", ")}`;
  }
  if (expense.splitMode === "equal") {
    return `Equal split · ${names.join(", ")}`;
  }
  if (expense.splitMode === "weighted") {
    return `Weighted split · ${names.join(", ")}`;
  }
  return `Exact split · ${names.join(", ")}`;
}

function confidenceBadgeClass(confidence: "low" | "medium" | "high"): string {
  if (confidence === "high") {
    return "bg-emerald-100 text-emerald-800";
  }
  if (confidence === "medium") {
    return "bg-amber-100 text-amber-800";
  }
  return "bg-zinc-200 text-zinc-700";
}

function isUploadTerminal(status: UploadStatus): boolean {
  return status === "imported" || status === "receipt_added" || status === "needs_help" || status === "failed";
}

function commandNeedsExpense(command: TransactionCommand): boolean {
  return command.type !== "exclude" && command.type !== "include";
}

function mergeClassNames(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
  return Promise.resolve();
}

function buildSettlementDraftText(params: {
  tripName: string;
  currency: string;
  reviewedCount: number;
  totalCount: number;
  unresolvedMinor: number;
  members: Member[];
  ledgers: Array<{ memberId: string; balanceMinor: number; paidMinor: number; owedMinor: number }>;
  transfers: Transfer[];
}): string {
  const header = [
    `Settle draft for ${params.tripName}`,
    `${params.reviewedCount} of ${params.totalCount} transactions reviewed`,
    `${formatMinorUnits(params.unresolvedMinor, params.currency)} still unresolved`,
    "",
    "Member balances",
  ];

  const ledgerLines = params.ledgers.map((ledger) => {
    const name = memberName(params.members, ledger.memberId);
    return `- ${name}: paid ${formatMinorUnits(ledger.paidMinor, params.currency)}, share ${formatMinorUnits(ledger.owedMinor, params.currency)}, net ${formatMinorUnits(ledger.balanceMinor, params.currency)}`;
  });

  const transferLines =
    params.transfers.length === 0
      ? ["- No transfers needed yet."]
      : params.transfers.map((transfer) => {
          const from = memberName(params.members, transfer.fromMemberId);
          const to = memberName(params.members, transfer.toMemberId);
          return `- ${from} pays ${to} ${formatMinorUnits(transfer.amountMinor, params.currency)}`;
        });

  return [...header, ...ledgerLines, "", "Suggested transfers", ...transferLines].join("\n");
}

function resolveUploadKind(item: UploadQueueItem): UploadKind | null {
  if (item.overrideKind) {
    return item.overrideKind;
  }
  if (item.detectedKind === "statement" || item.detectedKind === "receipt") {
    return item.detectedKind;
  }
  return null;
}

function parseFriendNames(text: string): { names: string[]; error: string | null } {
  if (!text.trim()) {
    return { names: [], error: null };
  }

  const tokens = text.split(",").map((token) => token.trim());
  if (tokens.some((token) => token.length === 0)) {
    return {
      names: [],
      error: "Remove empty friend names (for example, avoid double commas).",
    };
  }

  const names: string[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (seen.has(normalized)) {
      duplicates.add(token);
      continue;
    }
    seen.add(normalized);
    names.push(token);
  }

  if (duplicates.size > 0) {
    return {
      names: [],
      error: `Duplicate friend names: ${[...duplicates].join(", ")}.`,
    };
  }

  return { names, error: null };
}

export default function Home() {
  const { ready, state, derived, actions, error } = useSettle();

  const [setupForm, setSetupForm] = useState<SetupFormState>({
    creatorName: "",
    tripName: "Bali Trip",
    startDate: PILOT_START_DATE,
    endDate: PILOT_END_DATE,
    settlementCurrency: DEFAULT_SETTLEMENT_CURRENCY,
    friendNamesText: "",
  });
  const [setupFieldErrors, setSetupFieldErrors] = useState<SetupFieldErrors>({});

  const [uploadItems, setUploadItems] = useState<UploadQueueItem[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [processingBatchId, setProcessingBatchId] = useState<string | null>(null);
  const [openRecoveryId, setOpenRecoveryId] = useState<string | null>(null);
  const [recoveryTextByItemId, setRecoveryTextByItemId] = useState<Record<string, string>>({});

  const [focusedTransactionId, setFocusedTransactionId] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [showEditDrawer, setShowEditDrawer] = useState(false);
  const [autoDraftedTransactionIds, setAutoDraftedTransactionIds] = useState<string[]>([]);

  const [commandInput, setCommandInput] = useState("");
  const [pendingCommand, setPendingCommand] = useState<PendingCommandPreview | null>(null);
  const [status, setStatus] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PendingUndoAction | null>(null);
  const [undoAnnouncement, setUndoAnnouncement] = useState("");
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMemberName, setNewMemberName] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadItemsRef = useRef<UploadQueueItem[]>([]);
  const processingRef = useRef(false);

  const effectiveError = error ?? localError;

  useEffect(() => {
    uploadItemsRef.current = uploadItems;
  }, [uploadItems]);

  const updateUploadItem = useCallback((itemId: string, updater: (item: UploadQueueItem) => UploadQueueItem) => {
    setUploadItems((previous) =>
      previous.map((item) => {
        if (item.id !== itemId) {
          return item;
        }
        return updater(item);
      }),
    );
  }, []);

  const reportStatus = useCallback((message: string) => {
    setLocalError(null);
    setStatus(message);
  }, []);

  const reportError = useCallback((message: string) => {
    setStatus("");
    setLocalError(message);
  }, []);

  const startUndoWindow = useCallback((undo: Omit<PendingUndoAction, "expiresAt">) => {
    setPendingUndo({
      ...undo,
      expiresAt: Date.now() + 5000,
    });
    setUndoAnnouncement(`Undo available for ${undo.label}.`);
  }, []);

  useEffect(() => {
    if (!pendingUndo) {
      return;
    }

    const remainingMs = pendingUndo.expiresAt - Date.now();
    const timer = window.setTimeout(() => {
      setPendingUndo(null);
    }, Math.max(remainingMs, 0));

    return () => window.clearTimeout(timer);
  }, [pendingUndo]);

  const importExtractedText = useCallback(
    (itemId: string, kind: UploadKind, text: string, sourceName: string, warning: string | null) => {
      const normalizedText = text.trim();

      if (kind === "statement") {
        const result = actions.importStatementText(normalizedText, sourceName);
        if (result.addedCount > 0) {
          const sourceDraftId = uploadItemsRef.current.find((item) => item.id === itemId)?.sourceDraftId;
          if (sourceDraftId) actions.resolveSourceDraft(sourceDraftId);
          updateUploadItem(itemId, (item) => ({
            ...item,
            status: "imported",
            importedCount: result.addedCount,
            duplicateCount: result.duplicateCount,
            message: `${result.addedCount} transaction row(s) imported. ${result.duplicateCount} duplicate(s) skipped.`,
            warning,
          }));
          return;
        }

        const existingSourceDraftId = uploadItemsRef.current.find((item) => item.id === itemId)?.sourceDraftId;
        const sourceDraftId =
          existingSourceDraftId ??
          actions.addSourceDraft(
            sourceName,
            "statement",
            warning ??
              "No rows were imported. The pilot statement parser currently supports Standard Chartered layouts.",
          );
        updateUploadItem(itemId, (item) => ({
          ...item,
          status: "needs_help",
          sourceDraftId,
          importedCount: 0,
          duplicateCount: result.duplicateCount,
          message:
            warning ??
            "No rows were imported. The pilot statement parser currently supports Standard Chartered layouts. Open Recovery to paste clean rows or save this as receipt evidence.",
          warning,
        }));
        return;
      }

      if (!normalizedText) {
        const existingSourceDraftId = uploadItemsRef.current.find((item) => item.id === itemId)?.sourceDraftId;
        const sourceDraftId =
          existingSourceDraftId ??
          actions.addSourceDraft(
            sourceName,
            "receipt",
            warning ?? "No readable receipt text found.",
          );
        updateUploadItem(itemId, (item) => ({
          ...item,
          status: "needs_help",
          sourceDraftId,
          message: warning ?? "No readable receipt text found. Paste or correct text, then save as receipt.",
          warning,
        }));
        return;
      }

      actions.addReceiptFromText(normalizedText, sourceName);
      const sourceDraftId = uploadItemsRef.current.find((item) => item.id === itemId)?.sourceDraftId;
      if (sourceDraftId) actions.resolveSourceDraft(sourceDraftId);
      updateUploadItem(itemId, (item) => ({
        ...item,
        status: "receipt_added",
        message: "Receipt extracted and added.",
        warning,
      }));
    },
    [actions, updateUploadItem],
  );

  const processUploadBatch = useCallback(
    async (batchId: string) => {
      if (!state.trip || processingRef.current) {
        return;
      }

      processingRef.current = true;
      setProcessingBatchId(batchId);

      const queued = uploadItemsRef.current.filter(
        (item) => item.batchId === batchId && item.status === "queued",
      );

      for (const item of queued) {
        updateUploadItem(item.id, (previous) => ({
          ...previous,
          status: "reading",
          message: "Extracting text...",
        }));

        try {
          const extracted = await extractDocumentText(item.file);
          const classification = classifyExtractedText(extracted.text);

          updateUploadItem(item.id, (previous) => ({
            ...previous,
            status: "extracted",
            extractedText: extracted.text,
            classification,
            detectedKind: classification.kind,
            warning: extracted.warning,
            message: classification.reason,
          }));

          const effectiveKind = resolveUploadKind({
            ...item,
            classification,
            detectedKind: classification.kind,
            extractedText: extracted.text,
          });

          if (!effectiveKind) {
            const helpMessage =
              classification.kind === "possible_statement"
                ? "Possible statement detected, but this pilot auto-imports only Standard Chartered layouts. Use Recovery to clean the rows, then import as statement."
                : `${classification.reason} Pick statement or receipt to continue.`;
            const sourceDraftId = actions.addSourceDraft(item.fileName, "receipt", helpMessage);
            updateUploadItem(item.id, (previous) => ({
              ...previous,
              status: "needs_help",
              sourceDraftId,
              message: helpMessage,
              warning: extracted.warning,
            }));
            continue;
          }

          importExtractedText(item.id, effectiveKind, extracted.text, item.fileName, extracted.warning);
        } catch (processingError) {
          const failureMessage =
            processingError instanceof Error
              ? processingError.message
              : "Extraction failed. Open recovery to paste text manually.";
          const sourceDraftId = actions.addSourceDraft(item.fileName, "receipt", failureMessage);
          updateUploadItem(item.id, (previous) => ({
            ...previous,
            status: "failed",
            sourceDraftId,
            message: failureMessage,
          }));
        }
      }

      processingRef.current = false;
      setProcessingBatchId(null);
      reportStatus("Batch processing complete.");
    },
    [actions, importExtractedText, reportStatus, state.trip, updateUploadItem],
  );

  useEffect(() => {
    if (!state.trip || processingRef.current) {
      return;
    }
    const nextBatchId = uploadItems.find((item) => item.status === "queued")?.batchId;
    if (nextBatchId) {
      void processUploadBatch(nextBatchId);
    }
  }, [processUploadBatch, state.trip, uploadItems]);

  const enqueueFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      const batchId = `batch_${Date.now()}`;
      const nowQueued = files.map((file) => {
        const statementError = validateUpload(file, "statement");
        const receiptError = validateUpload(file, "receipt");
        const accepted = !statementError || !receiptError;

        const status: UploadStatus = accepted ? "queued" : "failed";
        const message = accepted
          ? "Queued"
          : statementError === receiptError
          ? statementError ?? "Unsupported file"
          : "Unsupported file";

        const sourceDraftId = accepted
          ? null
          : actions.addSourceDraft(
              file.name,
              "receipt",
              message,
            );

        return {
          id: makeId("upload"),
          batchId,
          file,
          fileName: file.name,
          mimeType: file.type,
          status,
          detectedKind: "unknown" as ClassifiedDocumentKind,
          classification: null,
          overrideKind: null,
          extractedText: "",
          warning: null,
          message,
          importedCount: 0,
          duplicateCount: 0,
          sourceDraftId,
        } satisfies UploadQueueItem;
      });

      setUploadItems((previous) => [...nowQueued, ...previous]);
      setActiveBatchId(batchId);

      if (!state.trip) {
        reportStatus("Files queued. Create the trip to start extraction.");
        return;
      }

      void processUploadBatch(batchId);
    },
    [actions, processUploadBatch, reportStatus, state.trip],
  );

  const handleInputFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = [...(event.target.files ?? [])];
      enqueueFiles(files);
      event.target.value = "";
    },
    [enqueueFiles],
  );

  const approvedTransactionIds = useMemo(
    () => buildApprovedTransactionIdSet(state.expenses),
    [state.expenses],
  );

  const unapprovedTransactionIds = useMemo(
    () => buildUnapprovedTransactionIdSet(state.expenses),
    [state.expenses],
  );

  const receiptSuggestionsByTransactionId = useMemo(() => {
    const suggestions = new Map<
      string,
      {
        receiptId: string;
        score: number;
        confidence: "low" | "medium" | "high";
        evidence: string[];
      }
    >();

    for (const receipt of state.receipts) {
      const matches = suggestReceiptMatches(receipt, state.statementTransactions, {
        isEligible: (transaction) => !transaction.isPayment,
      });

      for (const match of matches) {
        const existing = suggestions.get(match.transactionId);
        if (!existing || match.score > existing.score) {
          suggestions.set(match.transactionId, {
            receiptId: receipt.id,
            score: match.score,
            confidence: match.confidence,
            evidence: match.evidence,
          });
        }
      }
    }

    return suggestions;
  }, [state.receipts, state.statementTransactions]);

  const expensesByTransactionId = useMemo(() => {
    const map = new Map<string, Expense>();
    for (const expense of state.expenses) {
      if (!expense.evidence.statementTransactionId) {
        continue;
      }
      if (!map.has(expense.evidence.statementTransactionId)) {
        map.set(expense.evidence.statementTransactionId, expense);
      }
    }
    return map;
  }, [state.expenses]);

  const receiptsById = useMemo(() => {
    const map = new Map<string, ReceiptEvidence>();
    for (const receipt of state.receipts) {
      map.set(receipt.id, receipt);
    }
    return map;
  }, [state.receipts]);

  const reviewProgress = useMemo(
    () => computeReviewProgress(state.statementTransactions, state.expenses),
    [state.expenses, state.statementTransactions],
  );

  const reviewCards = useMemo(() => {
    const cards: ReviewCardModel[] = state.statementTransactions.map((transaction) => {
      const expense = expensesByTransactionId.get(transaction.id) ?? null;
      const reviewed = isTransactionReviewed(
        transaction,
        approvedTransactionIds,
        unapprovedTransactionIds,
      );
      const suggestedReceipt = receiptSuggestionsByTransactionId.get(transaction.id) ?? null;

      let confidence: "low" | "medium" | "high" = "low";
      const confidenceReasons: string[] = [];

      if (transaction.isPayment) {
        confidence = "high";
        confidenceReasons.push("Payment row detected and auto-excluded.");
      } else if (expense?.receiptMatch) {
        confidence = expense.receiptMatch.confidence;
        confidenceReasons.push(...expense.receiptMatch.evidence);
      } else if (suggestedReceipt) {
        confidence = suggestedReceipt.confidence;
        confidenceReasons.push(...suggestedReceipt.evidence);
      } else if (transaction.isFeeOrTax) {
        confidence = "medium";
        confidenceReasons.push("Fee/tax row detected from statement pattern.");
      } else {
        confidence = "low";
        confidenceReasons.push("No receipt evidence linked yet.");
      }

      const impactMinor = Math.abs(transaction.postedAmountMinor ?? transaction.originalAmountMinor);
      const uncertaintyRank = confidence === "low" ? 3 : confidence === "medium" ? 2 : 1;

      return {
        transaction,
        expense,
        reviewed,
        confidence,
        confidenceReasons,
        suggestedReceipt,
        impactMinor,
        uncertaintyRank,
      };
    });

    cards.sort((left, right) => {
      if (left.reviewed !== right.reviewed) {
        return left.reviewed ? 1 : -1;
      }

      if (!left.reviewed && !right.reviewed) {
        if (left.uncertaintyRank !== right.uncertaintyRank) {
          return right.uncertaintyRank - left.uncertaintyRank;
        }
        if (left.impactMinor !== right.impactMinor) {
          return right.impactMinor - left.impactMinor;
        }
      }

      return right.transaction.date.localeCompare(left.transaction.date);
    });

    return cards;
  }, [
    approvedTransactionIds,
    expensesByTransactionId,
    receiptSuggestionsByTransactionId,
    state.statementTransactions,
    unapprovedTransactionIds,
  ]);

  const resolvedFocusedTransactionId =
    focusedTransactionId && reviewCards.some((item) => item.transaction.id === focusedTransactionId)
      ? focusedTransactionId
      : reviewCards.find((item) => !item.reviewed)?.transaction.id ?? reviewCards[0]?.transaction.id ?? null;
  const focusedCard =
    reviewCards.find((card) => card.transaction.id === resolvedFocusedTransactionId) ?? null;

  useEffect(() => {
    if (!focusedCard || focusedCard.reviewed) {
      return;
    }
    if (focusedCard.transaction.inclusionState !== "included" || focusedCard.transaction.isPayment) {
      return;
    }
    if (focusedCard.expense) {
      return;
    }
    if (autoDraftedTransactionIds.includes(focusedCard.transaction.id)) {
      return;
    }

    actions.createExpenseFromTransaction(
      focusedCard.transaction.id,
      focusedCard.suggestedReceipt?.receiptId ?? null,
    );
    queueMicrotask(() => {
      setAutoDraftedTransactionIds((previous) => [...previous, focusedCard.transaction.id]);
      reportStatus("Draft expense generated for the focused transaction.");
    });
  }, [actions, autoDraftedTransactionIds, focusedCard, reportStatus]);

  const focusedIndex = focusedCard
    ? reviewCards.findIndex((card) => card.transaction.id === focusedCard.transaction.id)
    : -1;
  const previousCard = focusedIndex > 0 ? reviewCards[focusedIndex - 1] : null;
  const nextCard = focusedIndex >= 0 && focusedIndex < reviewCards.length - 1 ? reviewCards[focusedIndex + 1] : null;

  const unresolvedAmountMinor = useMemo(() => {
    if (!state.trip) {
      return 0;
    }

    let total = 0;
    for (const card of reviewCards) {
      if (card.reviewed) {
        continue;
      }
      if (card.transaction.inclusionState !== "included" || card.transaction.isPayment) {
        continue;
      }

      if (card.expense) {
        total += card.expense.settlementAmountMinor;
        continue;
      }

      const resolved = resolveSettlementAmountFromTransaction(card.transaction, state.trip);
      total += resolved.settlementAmountMinor;
    }
    return total;
  }, [reviewCards, state.trip]);

  const filesProcessed = uploadItems.filter((item) => item.status !== "queued" && item.status !== "reading").length;
  const receiptsMatched = state.expenses.filter((expense) => Boolean(expense.evidence.receiptId)).length;
  const likelyPersonalCount = state.expenses.filter((expense) => expense.likelyPersonal.likely).length;
  const estimatedReviewMinutes = Math.ceil(reviewProgress.unresolvedTransactions * 0.6);

  const activeBatchItems = activeBatchId
    ? uploadItems.filter((item) => item.batchId === activeBatchId)
    : [];
  const activeBatchDone = activeBatchItems.filter((item) => isUploadTerminal(item.status)).length;

  const applyPendingCommand = useCallback(() => {
    if (!pendingCommand || !state.trip) {
      return;
    }

    const transaction = state.statementTransactions.find((item) => item.id === pendingCommand.transactionId);
    if (!transaction) {
      setPendingCommand(null);
      return;
    }

    const expense = expensesByTransactionId.get(transaction.id) ?? null;

    switch (pendingCommand.command.type) {
      case "exclude": {
        const result = actions.excludeTransaction(transaction.id);
        if (!result.ok) {
          reportError(result.reason ?? "Could not exclude transaction.");
          break;
        }
        reportStatus("Transaction excluded.");
        startUndoWindow({
          kind: "exclude",
          label: "exclude",
          transactionId: transaction.id,
          restoreExpense: result.removedExpense,
          restoreComments: result.removedComments,
        });
        break;
      }
      case "include": {
        const result = actions.includeTransaction(transaction.id);
        if (!result.ok) {
          reportError(result.reason ?? "Could not include transaction.");
          break;
        }
        reportStatus("Transaction included.");
        break;
      }
      case "set_personal": {
        if (!expense) {
          reportError("Draft expense not ready yet.");
          break;
        }
        actions.updateExpenseDraft({
          expenseId: expense.id,
          title: expense.title,
          date: expense.date,
          payerId: expense.payerId,
          settlementAmountMinor: expense.settlementAmountMinor,
          splitMode: "personal",
          splitConfig: { participantIds: [expense.payerId] },
          notes: expense.notes,
          fxRule: expense.fxRule,
          fxRate: expense.fxRate,
        });
        reportStatus("Applied: personal split.");
        break;
      }
      case "split_all": {
        if (!expense) {
          reportError("Draft expense not ready yet.");
          break;
        }
        actions.updateExpenseDraft({
          expenseId: expense.id,
          title: expense.title,
          date: expense.date,
          payerId: expense.payerId,
          settlementAmountMinor: expense.settlementAmountMinor,
          splitMode: "equal",
          splitConfig: { participantIds: state.members.map((member) => member.id) },
          notes: expense.notes,
          fxRule: expense.fxRule,
          fxRate: expense.fxRate,
        });
        reportStatus("Applied: split between everyone.");
        break;
      }
      case "split_between": {
        if (!expense) {
          reportError("Draft expense not ready yet.");
          break;
        }
        actions.updateExpenseDraft({
          expenseId: expense.id,
          title: expense.title,
          date: expense.date,
          payerId: expense.payerId,
          settlementAmountMinor: expense.settlementAmountMinor,
          splitMode: "equal",
          splitConfig: { participantIds: pendingCommand.command.participantIds },
          notes: expense.notes,
          fxRule: expense.fxRule,
          fxRate: expense.fxRate,
        });
        reportStatus(`Applied: split between ${pendingCommand.command.participantNames.join(", ")}.`);
        break;
      }
      case "set_payer": {
        if (!expense) {
          reportError("Draft expense not ready yet.");
          break;
        }
        const splitConfig =
          expense.splitMode === "personal"
            ? { participantIds: [pendingCommand.command.payerId] }
            : expense.splitConfig;

        actions.updateExpenseDraft({
          expenseId: expense.id,
          title: expense.title,
          date: expense.date,
          payerId: pendingCommand.command.payerId,
          settlementAmountMinor: expense.settlementAmountMinor,
          splitMode: expense.splitMode,
          splitConfig,
          notes: expense.notes,
          fxRule: expense.fxRule,
          fxRate: expense.fxRate,
        });
        reportStatus(`Applied: ${pendingCommand.command.payerName} set as payer.`);
        break;
      }
      case "attach_receipt": {
        if (!expense) {
          reportError("Draft expense not ready yet.");
          break;
        }
        actions.attachReceiptToExpense(expense.id, pendingCommand.command.receiptId);
        reportStatus(`Attached receipt ${pendingCommand.command.receiptLabel}.`);
        break;
      }
      default:
        break;
    }

    setPendingCommand(null);
    setCommandInput("");
  }, [
    actions,
    expensesByTransactionId,
    pendingCommand,
    reportError,
    reportStatus,
    startUndoWindow,
    state.members,
    state.statementTransactions,
    state.trip,
  ]);

  const previewCommand = useCallback(() => {
    if (!focusedCard) {
      return;
    }

    const parsed = parseTransactionCommand(
      commandInput,
      state.members,
      state.activeMemberId,
      state.receipts.map((receipt) => ({
        id: receipt.id,
        sourceName: receipt.sourceName,
        merchant: receipt.merchant,
        bookingIds: receipt.bookingIds,
      })),
    );
    if (!parsed.ok) {
      reportError(parsed.error);
      setPendingCommand(null);
      return;
    }

    const currentExpense = focusedCard.expense;
    if (commandNeedsExpense(parsed.command) && !currentExpense) {
      reportError("Draft expense is not ready yet. Use 'Generate draft' or wait for auto-draft.");
      setPendingCommand(null);
      return;
    }

    const before = currentExpense
      ? `${memberName(state.members, currentExpense.payerId)} · ${splitLabel(currentExpense, state.members)}`
      : `Transaction is ${focusedCard.transaction.inclusionState}`;

    let after = parsed.preview;
    if (currentExpense) {
      if (parsed.command.type === "set_personal") {
        after = `${memberName(state.members, currentExpense.payerId)} · Personal split`;
      }
      if (parsed.command.type === "split_all") {
        after = `Equal split across ${state.members.length} member(s)`;
      }
      if (parsed.command.type === "split_between") {
        after = `Equal split between ${parsed.command.participantNames.join(", ")}`;
      }
      if (parsed.command.type === "set_payer") {
        after = `${parsed.command.payerName} pays · ${splitLabel(currentExpense, state.members)}`;
      }
      if (parsed.command.type === "attach_receipt") {
        after = `Attach ${parsed.command.receiptLabel}`;
      }
    }

    if (parsed.command.type === "exclude") {
      after = "Transaction will be excluded from settlement.";
    }
    if (parsed.command.type === "include") {
      after = "Transaction will be included in settlement.";
    }

    setPendingCommand({
      transactionId: focusedCard.transaction.id,
      command: parsed.command,
      before,
      after,
    });
    reportStatus("Command parsed. Confirm to apply.");
  }, [
    commandInput,
    focusedCard,
    reportError,
    reportStatus,
    state.activeMemberId,
    state.members,
    state.receipts,
  ]);

  if (!ready) {
    return <main className="p-6 text-zinc-700">Loading Settle...</main>;
  }

  const openFiles = () => fileInputRef.current?.click();

  if (!state.trip) {
    return (
      <main className="min-h-screen bg-white px-4 py-8 text-zinc-900 md:px-6 md:py-12">
        <input
          ref={fileInputRef}
          className="hidden"
          type="file"
          multiple
          accept=".csv,.txt,.json,.pdf,.png,.jpg,.jpeg,.webp,application/pdf,text/plain,text/csv,application/json,image/png,image/jpeg,image/webp"
          onChange={handleInputFileChange}
        />

        <section className="mx-auto max-w-3xl rounded-[30px] bg-[#efede7] p-5 shadow-[0_20px_80px_rgba(0,0,0,0.06)] md:p-8">
          <p className="text-sm uppercase tracking-[0.16em] text-zinc-500">Settle</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            Drop the trip. We&apos;ll work out the rest.
          </h1>
          <p className="mt-3 text-sm text-zinc-600">
            Saved on this device. Add files now or create the trip first and upload later.
          </p>

          <form
            className="mt-8 grid gap-4"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();

              const nextSetupErrors: SetupFieldErrors = {};
              const creatorName = setupForm.creatorName.trim();
              const tripName = setupForm.tripName.trim();

              if (!creatorName) {
                nextSetupErrors.creatorName = "Creator name is required.";
              }
              if (!tripName) {
                nextSetupErrors.tripName = "Trip name is required.";
              }

              const parsedFriends = parseFriendNames(setupForm.friendNamesText);
              if (parsedFriends.error) {
                nextSetupErrors.friendNamesText = parsedFriends.error;
              }

              if (Object.keys(nextSetupErrors).length > 0) {
                setSetupFieldErrors(nextSetupErrors);
                reportError("Fix setup errors before creating the trip.");
                return;
              }

              setSetupFieldErrors({});

              const result = actions.createTrip({
                creatorName,
                tripName,
                startDate: setupForm.startDate,
                endDate: setupForm.endDate,
                settlementCurrency: setupForm.settlementCurrency.toUpperCase(),
                defaultFxRule: DEFAULT_FX_RULE,
                fixedTripRate: null,
                friendNames: parsedFriends.names,
              });

              if (!result.ok) {
                reportError(result.reason ?? "Could not create trip.");
                return;
              }

              reportStatus("Trip created.");
            }}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm">
                <span>Creator</span>
                <input
                  className="h-11 rounded-2xl border border-zinc-300 bg-white px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black"
                  value={setupForm.creatorName}
                  onChange={(event) => {
                    setSetupForm((previous) => ({ ...previous, creatorName: event.target.value }));
                    setSetupFieldErrors((previous) => ({ ...previous, creatorName: undefined }));
                  }}
                  required
                />
                {setupFieldErrors.creatorName ? (
                  <span className="text-xs text-red-600">{setupFieldErrors.creatorName}</span>
                ) : null}
              </label>

              <label className="grid gap-2 text-sm">
                <span>Trip name</span>
                <input
                  className="h-11 rounded-2xl border border-zinc-300 bg-white px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black"
                  value={setupForm.tripName}
                  onChange={(event) => {
                    setSetupForm((previous) => ({ ...previous, tripName: event.target.value }));
                    setSetupFieldErrors((previous) => ({ ...previous, tripName: undefined }));
                  }}
                  required
                />
                {setupFieldErrors.tripName ? (
                  <span className="text-xs text-red-600">{setupFieldErrors.tripName}</span>
                ) : null}
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm">
                <span>Start date</span>
                <input
                  type="date"
                  className="h-11 rounded-2xl border border-zinc-300 bg-white px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black"
                  value={setupForm.startDate}
                  onChange={(event) =>
                    setSetupForm((previous) => ({ ...previous, startDate: event.target.value }))
                  }
                />
              </label>

              <label className="grid gap-2 text-sm">
                <span>End date</span>
                <input
                  type="date"
                  className="h-11 rounded-2xl border border-zinc-300 bg-white px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black"
                  value={setupForm.endDate}
                  onChange={(event) =>
                    setSetupForm((previous) => ({ ...previous, endDate: event.target.value }))
                  }
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm">
                <span>Settlement currency</span>
                <input
                  maxLength={3}
                  className="h-11 rounded-2xl border border-zinc-300 bg-white px-3 uppercase focus-visible:outline focus-visible:outline-2 focus-visible:outline-black"
                  value={setupForm.settlementCurrency}
                  onChange={(event) =>
                    setSetupForm((previous) => ({
                      ...previous,
                      settlementCurrency: event.target.value.toUpperCase(),
                    }))
                  }
                />
              </label>

              <label className="grid gap-2 text-sm">
                <span>Friend names</span>
                <input
                  className="h-11 rounded-2xl border border-zinc-300 bg-white px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black"
                  placeholder="Mira, Rohan, Sam"
                  value={setupForm.friendNamesText}
                  onChange={(event) => {
                    setSetupForm((previous) => ({ ...previous, friendNamesText: event.target.value }));
                    setSetupFieldErrors((previous) => ({ ...previous, friendNamesText: undefined }));
                  }}
                />
                {setupFieldErrors.friendNamesText ? (
                  <span className="text-xs text-red-600">{setupFieldErrors.friendNamesText}</span>
                ) : null}
              </label>
            </div>

            <div
              className="rounded-3xl border border-dashed border-zinc-400 bg-white/80 p-5"
              onDrop={(event) => {
                event.preventDefault();
                enqueueFiles([...event.dataTransfer.files]);
              }}
              onDragOver={(event) => {
                event.preventDefault();
              }}
            >
              <p className="text-sm font-medium">Universal file drop zone</p>
              <p className="mt-1 text-xs text-zinc-600">
                Pilot parser currently supports Standard Chartered statements. Other bank layouts are marked as possible statement for manual recovery.
              </p>
              <button
                type="button"
                className="mt-4 min-h-11 rounded-2xl bg-black px-4 text-sm font-medium text-white transition duration-200 active:scale-[0.98] motion-reduce:transition-none"
                onClick={openFiles}
              >
                Add files
              </button>

              {uploadItems.length > 0 ? (
                <ul className="mt-4 grid gap-2 text-xs text-zinc-700">
                  {uploadItems.slice(0, 6).map((item) => (
                    <li key={item.id} className="rounded-2xl bg-[#f4f2ec] px-3 py-2">
                      <span className="font-medium">{item.fileName}</span> · {item.status}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <button
                type="submit"
                className="min-h-11 rounded-2xl bg-black px-4 text-sm font-medium text-white transition duration-200 active:scale-[0.98] motion-reduce:transition-none"
              >
                Create trip
              </button>
              <button
                type="button"
                className="min-h-11 rounded-2xl border border-zinc-300 bg-white px-4 text-sm"
                onClick={() => {
                  actions.seedDemoTrip();
                  reportStatus("Loaded demo trip with synthetic data.");
                }}
              >
                Demo trip
              </button>
            </div>
          </form>

          <p className="mt-4 text-xs text-zinc-600">
            OCR language and worker assets are fetched by Tesseract.js at runtime. Extracted source text remains local in this browser session.
          </p>

          {effectiveError ? (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {effectiveError}
            </p>
          ) : null}
          <div aria-live="polite" className="mt-2 min-h-5 text-sm text-zinc-700">
            {status}
          </div>
          <div aria-live="polite" className="sr-only">
            {undoAnnouncement}
          </div>
        </section>
      </main>
    );
  }

  const trip = state.trip;
  const activeMemberId = state.activeMemberId ?? state.members[0]?.id ?? null;
  const lockedSnapshot = state.snapshot;
  const canLock =
    !lockedSnapshot &&
    derived.lockBlockers.pendingExpenses === 0 &&
    derived.lockBlockers.unlinkedIncludedTransactions === 0 &&
    derived.lockBlockers.pendingSourceDrafts === 0 &&
    derived.lockBlockers.unconfirmedPersonalExpenses === 0;

  const settlementLedgers = lockedSnapshot?.memberLedgers ?? derived.ledgers;
  const settlementTransfers = lockedSnapshot?.transfers ?? derived.transfers;

  const settlementDraftText = buildSettlementDraftText({
    tripName: trip.name,
    currency: trip.settlementCurrency,
    reviewedCount: reviewProgress.reviewedTransactions,
    totalCount: reviewProgress.totalTransactions,
    unresolvedMinor: unresolvedAmountMinor,
    members: state.members,
    ledgers: settlementLedgers,
    transfers: settlementTransfers,
  });

  return (
    <main className="min-h-screen bg-white px-3 pb-40 pt-4 text-zinc-900 md:px-6 md:pb-10 md:pt-6">
      <input
        ref={fileInputRef}
        className="hidden"
        type="file"
        multiple
        accept=".csv,.txt,.json,.pdf,.png,.jpg,.jpeg,.webp,application/pdf,text/plain,text/csv,application/json,image/png,image/jpeg,image/webp"
        onChange={handleInputFileChange}
      />

      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-[28px] bg-[#efede7] px-4 py-3">
          <div>
            <p className="text-sm uppercase tracking-[0.16em] text-zinc-500">Settle</p>
            <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{trip.name}</h1>
            <p className="text-xs text-zinc-600">
              {reviewProgress.reviewedTransactions} of {reviewProgress.totalTransactions} reviewed
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-zinc-600">
              <span className="mr-2">Reviewer</span>
              <select
                className="h-10 rounded-xl border border-zinc-300 bg-white px-2"
                value={activeMemberId ?? ""}
                onChange={(event) => actions.setActiveMember(event.target.value)}
              >
                {state.members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="min-h-11 rounded-2xl bg-black px-4 text-sm font-medium text-white transition duration-200 active:scale-[0.98] motion-reduce:transition-none"
              onClick={openFiles}
            >
              Add files
            </button>
            <button
              type="button"
              className="min-h-11 rounded-2xl border border-zinc-300 bg-white px-4 text-sm"
              onClick={() => {
                void copyText(settlementDraftText)
                  .then(() => reportStatus("Draft settlement copied."))
                  .catch(() => reportError("Could not copy draft settlement."));
              }}
            >
              Share
            </button>
            <button
              type="button"
              className="min-h-11 rounded-2xl border border-zinc-300 bg-white px-4 text-sm"
              onClick={() => setShowAddMember((previous) => !previous)}
            >
              {showAddMember ? "Close member" : "Add member"}
            </button>
            <button
              type="button"
              className="min-h-11 rounded-2xl border border-zinc-300 bg-white px-4 text-sm"
              onClick={() => {
                actions.resetAll();
                setUploadItems([]);
                setPendingCommand(null);
                setFocusedTransactionId(null);
                reportStatus("All local data cleared.");
              }}
            >
              Reset
            </button>
          </div>

          {showAddMember ? (
            <form
              className="mt-2 flex w-full flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const result = actions.addMember(newMemberName);
                if (!result.ok) {
                  reportError(result.reason ?? "Could not add member.");
                  return;
                }
                reportStatus(`Added member ${newMemberName.trim()}.`);
                setNewMemberName("");
              }}
            >
              <input
                className="h-10 min-w-[180px] rounded-xl border border-zinc-300 bg-white px-3 text-sm"
                placeholder="Friend name"
                value={newMemberName}
                onChange={(event) => setNewMemberName(event.target.value)}
              />
              <button
                type="submit"
                className="min-h-10 rounded-xl bg-black px-3 text-xs font-medium text-white"
              >
                Save member
              </button>
              <p className="text-xs text-zinc-600">You can start solo and add members later.</p>
            </form>
          ) : null}
        </header>

        <section className="rounded-[34px] bg-[#efede7] p-4 md:p-6">
          <div
            className="rounded-[28px] border border-dashed border-zinc-400 bg-white/90 p-4"
            onDrop={(event) => {
              event.preventDefault();
              enqueueFiles([...event.dataTransfer.files]);
            }}
            onDragOver={(event) => {
              event.preventDefault();
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Universal upload</p>
                <p className="text-xs text-zinc-600">
                  Statement and receipt files share one queue. Statement import currently supports Standard Chartered layouts in pilot mode.
                </p>
              </div>
              <button
                type="button"
                className="min-h-11 rounded-2xl bg-black px-4 text-sm font-medium text-white transition duration-200 active:scale-[0.98] motion-reduce:transition-none"
                onClick={openFiles}
              >
                Add files
              </button>
            </div>

            {activeBatchItems.length > 0 ? (
              <p className="mt-3 text-xs text-zinc-600">
                Batch progress: {activeBatchDone} of {activeBatchItems.length} processed
                {processingBatchId ? " (running...)" : ""}
              </p>
            ) : null}

            {uploadItems.length > 0 ? (
              <ul className="mt-4 grid gap-2">
                {uploadItems.map((item) => {
                  const recoveryText = recoveryTextByItemId[item.id] ?? item.extractedText;
                  const canRecover = item.status === "needs_help" || item.status === "failed";

                  return (
                    <li key={item.id} className="rounded-2xl bg-[#f4f2ec] p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{item.fileName}</p>
                          <p className="text-xs text-zinc-600">
                            {item.status.replaceAll("_", " ")} · {item.message}
                          </p>
                          {item.classification ? (
                            <p className="mt-1 text-xs text-zinc-500">
                              Detected: {item.classification.kind} ({item.classification.reason})
                            </p>
                          ) : null}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <label className="text-xs text-zinc-600">
                            Classify as
                            <select
                              className="ml-2 rounded-lg border border-zinc-300 bg-white px-2 py-1"
                              value={item.overrideKind ?? ""}
                              onChange={(event) =>
                                updateUploadItem(item.id, (previous) => ({
                                  ...previous,
                                  overrideKind: event.target.value ? (event.target.value as UploadKind) : null,
                                }))
                              }
                            >
                              <option value="">auto</option>
                              <option value="statement">statement</option>
                              <option value="receipt">receipt</option>
                            </select>
                          </label>

                          {(item.status === "extracted" || item.status === "needs_help") && resolveUploadKind(item) ? (
                            <button
                              type="button"
                              className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs"
                              onClick={() =>
                                importExtractedText(
                                  item.id,
                                  resolveUploadKind(item) as UploadKind,
                                  recoveryText,
                                  item.fileName,
                                  item.warning,
                                )
                              }
                            >
                              Import with classification
                            </button>
                          ) : null}

                          {canRecover ? (
                            <button
                              type="button"
                              className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs"
                              aria-expanded={openRecoveryId === item.id}
                              onClick={() => setOpenRecoveryId((previous) => (previous === item.id ? null : item.id))}
                            >
                              Recovery
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {openRecoveryId === item.id ? (
                        <div className="mt-3 rounded-xl border border-zinc-300 bg-white p-3">
                          <label className="grid gap-2 text-xs text-zinc-600">
                            <span>Extracted text</span>
                            <textarea
                              className="min-h-28 rounded-lg border border-zinc-300 px-2 py-2 font-mono text-xs"
                              value={recoveryText}
                              onChange={(event) =>
                                setRecoveryTextByItemId((previous) => ({
                                  ...previous,
                                  [item.id]: event.target.value,
                                }))
                              }
                            />
                          </label>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="min-h-11 rounded-xl bg-black px-3 text-xs font-medium text-white"
                              onClick={() =>
                                importExtractedText(item.id, "statement", recoveryText, item.fileName, item.warning)
                              }
                            >
                              Import as statement
                            </button>
                            <button
                              type="button"
                              className="min-h-11 rounded-xl border border-zinc-300 bg-white px-3 text-xs"
                              onClick={() =>
                                importExtractedText(item.id, "receipt", recoveryText, item.fileName, item.warning)
                              }
                            >
                              Save as receipt
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-zinc-600">No files yet. Add one batch to begin extraction.</p>
            )}
          </div>

          <article className="mt-4 rounded-[24px] bg-white/90 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-zinc-600">What Settle found</h2>
            <div className="mt-3 grid gap-2 text-sm md:grid-cols-3">
              <p className="rounded-2xl bg-[#f4f2ec] px-3 py-2">Files processed: {filesProcessed}</p>
              <p className="rounded-2xl bg-[#f4f2ec] px-3 py-2">
                Trip-window transactions: {state.statementTransactions.length}
              </p>
              <p className="rounded-2xl bg-[#f4f2ec] px-3 py-2">Receipts matched: {receiptsMatched}</p>
              <p className="rounded-2xl bg-[#f4f2ec] px-3 py-2">Likely personal flags: {likelyPersonalCount}</p>
              <p className="rounded-2xl bg-[#f4f2ec] px-3 py-2">Unresolved: {reviewProgress.unresolvedTransactions}</p>
              <p className="rounded-2xl bg-[#f4f2ec] px-3 py-2">
                Est. review time: {estimatedReviewMinutes > 0 ? `${estimatedReviewMinutes} min` : "done"}
              </p>
            </div>
          </article>

          <article className="mt-4 rounded-[28px] bg-white p-4 shadow-[0_14px_40px_rgba(0,0,0,0.07)] md:p-5">
            {focusedCard ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.14em] text-zinc-500">Focused transaction</p>
                    <h3 className="mt-1 text-2xl font-semibold tracking-tight">
                      {focusedCard.expense?.title ?? focusedCard.transaction.merchant}
                    </h3>
                    <p className="mt-1 text-sm text-zinc-600">
                      {focusedCard.transaction.date} · {focusedCard.transaction.sourceName}
                    </p>
                    <p className="mt-2 text-sm text-zinc-700">
                      Payer: {memberName(state.members, focusedCard.expense?.payerId ?? activeMemberId)}
                    </p>
                    <p className="mt-1 text-sm text-zinc-700">
                      Suggested split: {focusedCard.expense ? splitLabel(focusedCard.expense, state.members) : "Draft pending"}
                    </p>
                  </div>

                  <div className="text-right">
                    <p className="text-sm text-zinc-500">Original</p>
                    <p className="text-lg font-semibold tabular-nums">
                      {formatMinorUnits(
                        focusedCard.transaction.originalAmountMinor,
                        focusedCard.transaction.originalCurrency,
                      )}
                    </p>
                    <p className="mt-1 text-sm text-zinc-500">Posted</p>
                    <p className="text-sm tabular-nums">
                      {focusedCard.transaction.postedAmountMinor !== null && focusedCard.transaction.postedCurrency
                        ? formatMinorUnits(
                            focusedCard.transaction.postedAmountMinor,
                            focusedCard.transaction.postedCurrency,
                          )
                        : "-"}
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className={mergeClassNames(
                      "rounded-full px-2 py-1 font-medium",
                      confidenceBadgeClass(focusedCard.confidence),
                    )}
                  >
                    Confidence: {focusedCard.confidence}
                  </span>
                  <span className="rounded-full bg-zinc-200 px-2 py-1 text-zinc-700">
                    {focusedCard.reviewed ? "Reviewed" : "Needs review"}
                  </span>
                  {focusedCard.transaction.isPayment ? (
                    <span className="rounded-full bg-zinc-200 px-2 py-1 text-zinc-700">Payment row</span>
                  ) : null}
                </div>

                <p className="mt-2 text-sm text-zinc-700">{focusedCard.confidenceReasons.join(" ")}</p>

                <div className="mt-4 flex flex-wrap gap-2">
                  {!focusedCard.reviewed ? (
                    <>
                      {focusedCard.expense ? (
                        <button
                          type="button"
                          className="min-h-11 rounded-2xl bg-black px-4 text-sm font-medium text-white transition duration-200 active:scale-[0.98] motion-reduce:transition-none"
                          onClick={() => {
                            const expense = focusedCard.expense as Expense;
                            const approved = actions.approveExpense(expense.id);
                            if (approved) {
                              reportStatus("Transaction approved.");
                              startUndoWindow({
                                kind: "approve",
                                label: "approve",
                                expenseId: expense.id,
                              });
                            } else {
                              setStatus("");
                            }
                          }}
                        >
                          {focusedCard.expense.likelyPersonal.likely &&
                          !focusedCard.expense.personalClassificationConfirmed &&
                          focusedCard.expense.splitMode === "personal"
                            ? "Confirm personal + approve"
                            : "Approve"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="min-h-11 rounded-2xl border border-zinc-300 bg-white px-4 text-sm"
                          onClick={() => {
                            actions.createExpenseFromTransaction(
                              focusedCard.transaction.id,
                              focusedCard.suggestedReceipt?.receiptId ?? null,
                            );
                            reportStatus("Draft generated for this transaction.");
                          }}
                        >
                          Generate draft
                        </button>
                      )}

                      <button
                        type="button"
                        className="min-h-11 rounded-2xl border border-zinc-300 bg-white px-4 text-sm"
                        onClick={() => {
                          const transactionId = focusedCard.transaction.id;
                          if (focusedCard.transaction.inclusionState === "included") {
                            const result = actions.excludeTransaction(transactionId);
                            if (!result.ok) {
                              reportError(result.reason ?? "Could not exclude transaction.");
                              return;
                            }
                            reportStatus("Transaction excluded from settlement.");
                            startUndoWindow({
                              kind: "exclude",
                              label: "exclude",
                              transactionId,
                              restoreExpense: result.removedExpense,
                              restoreComments: result.removedComments,
                            });
                            return;
                          }

                          const includeResult = actions.includeTransaction(transactionId);
                          if (!includeResult.ok) {
                            reportError(includeResult.reason ?? "Could not include transaction.");
                            return;
                          }
                          reportStatus("Transaction included in settlement.");
                        }}
                      >
                        {focusedCard.transaction.inclusionState === "included" ? "Exclude" : "Include"}
                      </button>
                    </>
                  ) : null}

                  {focusedCard.expense ? (
                    <button
                      type="button"
                      className="min-h-11 rounded-2xl border border-zinc-300 bg-white px-4 text-sm"
                      aria-expanded={showEditDrawer}
                      onClick={() => setShowEditDrawer((previous) => !previous)}
                    >
                      {showEditDrawer ? "Close edit" : "Edit"}
                    </button>
                  ) : null}

                  <button
                    type="button"
                    className="min-h-11 rounded-2xl border border-zinc-300 bg-white px-4 text-sm"
                    aria-expanded={showEvidence}
                    onClick={() => setShowEvidence((previous) => !previous)}
                  >
                    {showEvidence ? "Hide evidence" : "Evidence"}
                  </button>

                  <button
                    type="button"
                    className="min-h-11 rounded-2xl border border-zinc-300 bg-white px-4 text-sm"
                    onClick={() => previousCard && setFocusedTransactionId(previousCard.transaction.id)}
                    disabled={!previousCard}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="min-h-11 rounded-2xl border border-zinc-300 bg-white px-4 text-sm"
                    onClick={() => nextCard && setFocusedTransactionId(nextCard.transaction.id)}
                    disabled={!nextCard}
                  >
                    Next
                  </button>
                </div>

                {showEvidence ? (
                  <div className="mt-4 rounded-2xl bg-[#f4f2ec] p-3 text-sm">
                    <p className="font-medium">Statement evidence</p>
                    <p className="mt-1 text-zinc-700">
                      {focusedCard.transaction.date} · {focusedCard.transaction.merchant} ·{" "}
                      {formatMinorUnits(
                        focusedCard.transaction.originalAmountMinor,
                        focusedCard.transaction.originalCurrency,
                      )}
                    </p>
                    <p className="mt-1 font-mono text-xs text-zinc-600">{focusedCard.transaction.rawText}</p>

                    {focusedCard.expense?.evidence.receiptId ? (
                      <div className="mt-3 rounded-xl bg-white p-3">
                        <p className="font-medium">Linked receipt evidence</p>
                        {(() => {
                          const receipt = receiptsById.get(focusedCard.expense?.evidence.receiptId ?? "");
                          if (!receipt) {
                            return <p className="mt-1 text-xs text-zinc-600">Linked receipt not found.</p>;
                          }
                          return (
                            <div className="mt-1 text-xs text-zinc-700">
                              <p>Merchant: {receipt.merchant}</p>
                              <p>Date: {receipt.date ?? "unknown"}</p>
                              <p>
                                Total: {formatMinorUnits(receipt.totalAmountMinor, receipt.currency)}
                              </p>
                              <p>
                                Booking IDs:{" "}
                                {receipt.bookingIds.length > 0 ? receipt.bookingIds.join(", ") : "none"}
                              </p>
                              <p>Passenger: {receipt.passengerName ?? "n/a"}</p>
                              <p>Service: {receipt.service ?? "n/a"}</p>
                              <details className="mt-2">
                                <summary className="cursor-pointer text-xs font-medium text-zinc-700">
                                  Extracted receipt text
                                </summary>
                                <pre className="mt-2 max-h-44 overflow-auto rounded-lg bg-zinc-100 p-2 font-mono text-[11px] leading-5 text-zinc-700">
                                  {receipt.text}
                                </pre>
                              </details>
                            </div>
                          );
                        })()}
                      </div>
                    ) : focusedCard.suggestedReceipt ? (
                      <div className="mt-3 rounded-xl bg-white p-3 text-xs text-zinc-700">
                        <p className="font-medium">Suggested receipt match</p>
                        <p className="mt-1">{focusedCard.suggestedReceipt.evidence.join(" • ")}</p>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {showEditDrawer && focusedCard.expense ? (
                  <div className="mt-4 rounded-2xl bg-[#f4f2ec] p-3">
                    <ExpenseEditor
                      key={focusedCard.expense.id}
                      expense={focusedCard.expense}
                      currency={trip.settlementCurrency}
                      members={state.members}
                      receipts={state.receipts}
                      onAttachReceipt={(receiptId) => {
                        actions.attachReceiptToExpense(focusedCard.expense?.id ?? "", receiptId);
                        reportStatus("Receipt attached to expense.");
                      }}
                      onSave={(input) => {
                        actions.updateExpenseDraft(input);
                        reportStatus("Expense updated.");
                        setShowEditDrawer(false);
                      }}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-zinc-600">Upload a statement to start transaction review.</p>
            )}
          </article>

          {previousCard || nextCard ? (
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {[previousCard, nextCard]
                .filter((card): card is ReviewCardModel => Boolean(card))
                .map((card) => (
                  <button
                    key={card.transaction.id}
                    type="button"
                    className="rounded-2xl bg-white/80 px-3 py-2 text-left text-sm transition duration-200 hover:bg-white motion-reduce:transition-none"
                    onClick={() => setFocusedTransactionId(card.transaction.id)}
                  >
                    <p className="font-medium">{card.transaction.merchant}</p>
                    <p className="text-xs text-zinc-600">
                      {card.transaction.date} · {card.reviewed ? "reviewed" : "needs review"}
                    </p>
                  </button>
                ))}
            </div>
          ) : null}

          <article className="mt-4 rounded-[24px] bg-white/90 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-zinc-600">
              {lockedSnapshot ? "Final settlement" : "Draft settlement"}
            </h2>
            <p className="mt-2 text-sm text-zinc-700">
              {reviewProgress.reviewedTransactions} of {reviewProgress.totalTransactions} reviewed
            </p>
            <p className="text-sm text-zinc-700">
              {formatMinorUnits(unresolvedAmountMinor, trip.settlementCurrency)} still unresolved
            </p>
            {lockedSnapshot ? (
              <p className="mt-1 rounded-xl bg-emerald-100 px-2 py-1 text-xs text-emerald-800">
                Locked at {new Date(lockedSnapshot.createdAt).toLocaleString()}.
              </p>
            ) : null}

            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {settlementLedgers.map((ledger) => (
                <div key={ledger.memberId} className="rounded-2xl bg-[#f4f2ec] px-3 py-2 text-sm">
                  <p className="font-medium">{memberName(state.members, ledger.memberId)}</p>
                  <p className="text-xs text-zinc-700">
                    Paid {formatMinorUnits(ledger.paidMinor, trip.settlementCurrency)} · Owes{" "}
                    {formatMinorUnits(ledger.owedMinor, trip.settlementCurrency)}
                  </p>
                  <p className="text-xs text-zinc-700">
                    Net {formatMinorUnits(ledger.balanceMinor, trip.settlementCurrency)}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-3 rounded-2xl bg-[#f4f2ec] p-3 text-sm">
              <p className="font-medium">Minimum transfers</p>
              {settlementTransfers.length === 0 ? (
                <p className="mt-1 text-xs text-zinc-700">No transfers needed yet.</p>
              ) : (
                <ul className="mt-2 grid gap-1 text-xs text-zinc-700">
                  {settlementTransfers.map((transfer, index) => (
                    <li key={`${transfer.fromMemberId}-${transfer.toMemberId}-${index}`}>
                      {memberName(state.members, transfer.fromMemberId)} pays{" "}
                      {memberName(state.members, transfer.toMemberId)}{" "}
                      {formatMinorUnits(transfer.amountMinor, trip.settlementCurrency)}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-11 rounded-2xl bg-black px-4 text-sm font-medium text-white disabled:opacity-40"
                disabled={!canLock || Boolean(lockedSnapshot)}
                onClick={() => {
                  const result = actions.lockSnapshot();
                  if (result.ok) {
                    reportStatus("Final settlement locked.");
                  } else {
                    reportError(result.reason ?? "Could not lock snapshot.");
                  }
                }}
              >
                {lockedSnapshot ? "Settlement locked" : "Lock final settlement"}
              </button>
              {!lockedSnapshot && !canLock ? (
                <p className="self-center text-xs text-zinc-600">
                  Lock blocked by unresolved expenses, unlinked rows, unresolved source help, or pending personal confirmations.
                </p>
              ) : null}
              {lockedSnapshot ? (
                <p className="self-center text-xs text-zinc-600">
                  Final settlement now renders from the locked snapshot.
                </p>
              ) : null}
            </div>
          </article>
        </section>
      </div>

      <section className="fixed bottom-0 left-0 right-0 border-t border-zinc-200 bg-white/95 p-3 backdrop-blur md:static md:mx-auto md:mt-4 md:w-full md:max-w-[1180px] md:rounded-[24px] md:border md:bg-[#efede7] md:p-4">
        <p className="text-xs uppercase tracking-[0.12em] text-zinc-500">Command for focused transaction</p>
        <div className="mt-2 flex gap-2">
          <label className="sr-only" htmlFor="command-input">
            Command
          </label>
          <input
            id="command-input"
            className="h-11 w-full rounded-2xl border border-zinc-300 bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-black"
            value={commandInput}
            onChange={(event) => setCommandInput(event.target.value)}
            placeholder="this was only me · shared by everyone · Rohan paid this in cash · attach receipt ZX-ALPHA"
          />
          <button
            type="button"
            className="min-h-11 rounded-2xl bg-black px-4 text-sm font-medium text-white"
            onClick={previewCommand}
          >
            Preview
          </button>
        </div>

        {pendingCommand ? (
          <div className="mt-2 rounded-2xl bg-[#f4f2ec] p-3 text-xs text-zinc-700">
            <p>Before: {pendingCommand.before}</p>
            <p className="mt-1">After: {pendingCommand.after}</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="min-h-11 rounded-xl bg-black px-3 text-xs font-medium text-white"
                onClick={applyPendingCommand}
              >
                Confirm
              </button>
              <button
                type="button"
                className="min-h-11 rounded-xl border border-zinc-300 bg-white px-3 text-xs"
                onClick={() => setPendingCommand(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {pendingUndo ? (
          <div className="mt-2 flex items-center gap-2 rounded-2xl bg-[#f4f2ec] p-2 text-xs text-zinc-700">
            <span>Last action: {pendingUndo.label}.</span>
            <button
              type="button"
              className="min-h-9 rounded-lg border border-zinc-300 bg-white px-2 py-1"
              onClick={() => {
                if (pendingUndo.kind === "approve" && pendingUndo.expenseId) {
                  actions.reopenExpense(pendingUndo.expenseId, "Undo approve action");
                  reportStatus("Approval undone. Expense reopened for review.");
                  setUndoAnnouncement("Approval undone.");
                  setPendingUndo(null);
                  return;
                }

                if (pendingUndo.kind === "exclude" && pendingUndo.transactionId) {
                  const includeResult = actions.includeTransaction(pendingUndo.transactionId, {
                    restoreExpense: pendingUndo.restoreExpense ?? null,
                    restoreComments: pendingUndo.restoreComments ?? [],
                  });
                  if (!includeResult.ok) {
                    reportError(includeResult.reason ?? "Could not undo exclusion.");
                    setPendingUndo(null);
                    return;
                  }
                  reportStatus("Exclusion undone.");
                  setUndoAnnouncement("Exclusion undone.");
                  setPendingUndo(null);
                }
              }}
            >
              Undo
            </button>
          </div>
        ) : null}

        {effectiveError ? (
          <p role="alert" className="mt-2 text-xs text-red-700">
            {effectiveError}
          </p>
        ) : null}

        <div aria-live="polite" className="mt-2 min-h-5 text-xs text-zinc-700">
          {status || (!effectiveError ? "Saved on this device." : "")}
        </div>
        <div aria-live="polite" className="sr-only">
          {undoAnnouncement}
        </div>
      </section>
    </main>
  );
}
