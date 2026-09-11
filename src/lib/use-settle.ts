"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DEFAULT_FX_RULE,
  DEFAULT_SETTLEMENT_CURRENCY,
  PILOT_END_DATE,
  PILOT_START_DATE,
} from "@/lib/constants";
import { dayDistance, parseIsoDate } from "@/lib/date";
import { canApproveExpense } from "@/lib/expense-policy";
import {
  recomputeSettlementAmountForExpense,
  resolveSettlementAmountFromTransaction,
} from "@/lib/fx";
import { computeMemberLedgers, computeTransferPlan } from "@/lib/ledger";
import { makeId } from "@/lib/id";
import { parseReceiptText, suggestReceiptMatches } from "@/lib/receipt-matching";
import { createRepository } from "@/lib/repository-factory";
import { countUnresolvedSourceDrafts } from "@/lib/source-draft-policy";
import { buildAllocations } from "@/lib/splits";
import { parseStandardCharteredStatement } from "@/lib/statement-parser";
import { detectLikelyPersonalExpense } from "@/lib/personal-flag";
import {
  excludeTransactionWithLinkedDraft,
  includeTransactionWithRestore,
} from "@/lib/transaction-inclusion";
import {
  AuditEvent,
  Expense,
  ExpenseComment,
  FxRule,
  MemberLedger,
  ReceiptEvidence,
  SettleState,
  SettlementSnapshot,
  SplitConfig,
  SplitMode,
  StatementTransaction,
  Transfer,
  Trip,
} from "@/lib/types";

interface TripSetupInput {
  creatorName: string;
  tripName: string;
  startDate: string;
  endDate: string;
  settlementCurrency: string;
  defaultFxRule: FxRule;
  fixedTripRate: number | null;
  friendNames: string[];
}

interface ManualExpenseInput {
  title: string;
  date: string;
  payerId: string;
  settlementAmountMinor: number;
  splitMode: SplitMode;
  splitConfig: SplitConfig;
  notes: string;
}

interface UpdateExpenseInput {
  expenseId: string;
  title: string;
  date: string;
  payerId: string;
  settlementAmountMinor: number;
  splitMode: SplitMode;
  splitConfig: SplitConfig;
  notes: string;
  fxRule: FxRule;
  fxRate: number | null;
}

interface ImportResult {
  addedCount: number;
  duplicateCount: number;
}

interface ActionResult {
  ok: boolean;
  reason: string | null;
}

interface ExcludeTransactionResult extends ActionResult {
  removedExpense: Expense | null;
  removedComments: ExpenseComment[];
}

interface IncludeTransactionOptions {
  restoreExpense?: Expense | null;
  restoreComments?: ExpenseComment[];
}

interface SettlementComputation {
  ledgers: MemberLedger[];
  transfers: Transfer[];
  transferStrategy: "exact" | "simplified";
  total: number;
}

interface LockBlockers {
  pendingExpenses: number;
  unlinkedIncludedTransactions: number;
  pendingSourceDrafts: number;
  unconfirmedPersonalExpenses: number;
}

const MIN_MEMBERS = 1;
const MAX_MEMBERS = 10;

const EMPTY_STATE: SettleState = {
  version: 1,
  mode: "local",
  trip: null,
  activeMemberId: null,
  members: [],
  statementTransactions: [],
  receipts: [],
  expenses: [],
  comments: [],
  auditEvents: [],
  snapshot: null,
  sourceDrafts: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

function safeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toIsoDateOrNull(raw: string | null): string | null {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    parseIsoDate(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

function redactAuditValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return {
      type: "array",
      count: value.length,
    };
  }

  if (typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  if (typeof source.id === "string" && typeof source.eventType === "string") {
    return {
      id: source.id,
      eventType: source.eventType,
    };
  }

  const allowedKeys = [
    "id",
    "tripId",
    "date",
    "merchant",
    "title",
    "payerId",
    "settlementAmountMinor",
    "settlementCurrency",
    "originalAmountMinor",
    "originalCurrency",
    "postedAmountMinor",
    "postedCurrency",
    "fxRule",
    "fxRate",
    "splitMode",
    "splitConfig",
    "allocations",
    "status",
    "inclusionState",
    "isCredit",
    "isPayment",
    "isFeeOrTax",
    "fingerprint",
    "reference",
    "likelyPersonal",
    "personalClassificationConfirmed",
    "name",
    "kind",
    "reason",
    "resolvedBy",
    "resolvedAt",
    "evidence",
    "createdBy",
    "approvedBy",
    "approvedAt",
    "reopenedAt",
    "startDate",
    "endDate",
    "defaultFxRule",
    "fixedTripRate",
    "memberLedgers",
    "transfers",
    "totalSpendMinor",
  ] as const;

  const redacted: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (!(key in source)) {
      continue;
    }

    const nextValue = source[key];
    if (key === "allocations" || key === "memberLedgers" || key === "transfers") {
      redacted[key] = Array.isArray(nextValue)
        ? {
            type: "array",
            count: nextValue.length,
          }
        : null;
      continue;
    }

    redacted[key] = nextValue;
  }

  return redacted;
}

function defaultTrip(): Trip {
  return {
    id: makeId("trip"),
    creatorName: "",
    name: "",
    startDate: PILOT_START_DATE,
    endDate: PILOT_END_DATE,
    settlementCurrency: DEFAULT_SETTLEMENT_CURRENCY,
    defaultFxRule: DEFAULT_FX_RULE,
    fixedTripRate: null,
    createdAt: nowIso(),
  };
}

function normalizeUniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names.map((value) => value.trim()).filter(Boolean)) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(name);
  }
  return unique;
}

function withAudit(
  state: SettleState,
  actorId: string,
  entityType: AuditEvent["entityType"],
  entityId: string,
  eventType: string,
  before: unknown,
  after: unknown,
): SettleState {
  const event: AuditEvent = {
    id: makeId("audit"),
    actorId,
    entityType,
    entityId,
    eventType,
    before: redactAuditValue(before),
    after: redactAuditValue(after),
    createdAt: nowIso(),
  };

  return {
    ...state,
    auditEvents: [event, ...state.auditEvents],
  };
}

function invalidateSnapshot(state: SettleState): SettleState {
  if (!state.snapshot) {
    return state;
  }
  return {
    ...state,
    snapshot: null,
  };
}

function recomputeLedgers(state: SettleState): SettlementComputation {
  const memberIds = state.members.map((member) => member.id);
  const approved = state.expenses.filter((expense) => expense.status === "approved");
  const ledgers = computeMemberLedgers(memberIds, approved);
  const transferPlan = computeTransferPlan(ledgers);
  const total = approved.reduce((sum, expense) => sum + expense.settlementAmountMinor, 0);
  return {
    ledgers,
    transfers: transferPlan.transfers,
    transferStrategy: transferPlan.strategy,
    total,
  };
}

function applyStateMigrations(state: SettleState): SettleState {
  return {
    ...state,
    mode: "local",
    auditEvents: state.auditEvents.map((eventItem) => ({
      ...eventItem,
      before: redactAuditValue(eventItem.before),
      after: redactAuditValue(eventItem.after),
    })),
    expenses: state.expenses.map((expense) => ({
      ...expense,
      personalClassificationConfirmed:
        typeof (expense as Expense & { personalClassificationConfirmed?: boolean })
          .personalClassificationConfirmed === "boolean"
          ? (expense as Expense & { personalClassificationConfirmed?: boolean })
              .personalClassificationConfirmed
          : !expense.likelyPersonal.likely,
    })),
    statementTransactions: state.statementTransactions.map((transaction) => ({
      ...transaction,
      rawText: safeString(transaction.rawText) ?? "",
    })),
    receipts: state.receipts.map((receipt) => ({
      ...receipt,
      date: toIsoDateOrNull(receipt.date),
    })),
    sourceDrafts: state.sourceDrafts.map((draft) => {
      const status = draft.status === "resolved" ? "resolved" : "needs_manual_review";
      const resolvedByRaw = safeString(
        (draft as typeof draft & { resolvedBy?: unknown }).resolvedBy,
      );
      const resolvedAtRaw = safeString(
        (draft as typeof draft & { resolvedAt?: unknown }).resolvedAt,
      );

      return {
        ...draft,
        status,
        resolvedBy: status === "resolved" ? resolvedByRaw : null,
        resolvedAt: status === "resolved" ? resolvedAtRaw : null,
      };
    }),
  };
}

function buildLockBlockers(state: SettleState): LockBlockers {
  const transactionExpenseLinks = new Set(
    state.expenses
      .map((expense) => expense.evidence.statementTransactionId)
      .filter((value): value is string => Boolean(value)),
  );

  const pendingExpenses = state.expenses.filter((expense) => expense.status !== "approved").length;
  const unlinkedIncludedTransactions = state.statementTransactions.filter(
    (transaction) =>
      transaction.inclusionState === "included" &&
      !transaction.isPayment &&
      !transactionExpenseLinks.has(transaction.id),
  ).length;
  const pendingSourceDrafts = countUnresolvedSourceDrafts(state.sourceDrafts);
  const unconfirmedPersonalExpenses = state.expenses.filter(
    (expense) =>
      expense.status === "approved" &&
      expense.likelyPersonal.likely &&
      !expense.personalClassificationConfirmed,
  ).length;

  return {
    pendingExpenses,
    unlinkedIncludedTransactions,
    pendingSourceDrafts,
    unconfirmedPersonalExpenses,
  };
}

function createInitialState(mode: "local"): SettleState {
  return {
    ...EMPTY_STATE,
    mode,
  };
}

export function useSettle() {
  const repository = useMemo(() => createRepository(), []);
  const [state, setState] = useState<SettleState>(() => createInitialState(repository.mode));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateState = useCallback(
    (producer: (previous: SettleState) => SettleState) => {
      setState((previous) => {
        const next = producer(previous);
        void repository.save(next).catch((saveError: unknown) => {
          setError(saveError instanceof Error ? saveError.message : "Failed to save state");
        });
        return next;
      });
    },
    [repository],
  );

  useEffect(() => {
    const raw = window.localStorage.getItem("settle_state_v1");
    queueMicrotask(() => {
      if (raw) {
        try {
          setState(applyStateMigrations(JSON.parse(raw) as SettleState));
        } catch {
          window.localStorage.removeItem("settle_state_v1");
        }
      }
      setReady(true);
    });
  }, []);

  const createTrip = useCallback(
    (input: TripSetupInput): ActionResult => {
      let startTime: number;
      let endTime: number;
      try {
        startTime = parseIsoDate(input.startDate).getTime();
        endTime = parseIsoDate(input.endDate).getTime();
      } catch {
        const reason = "Trip dates must be valid calendar dates.";
        setError(reason);
        return { ok: false, reason };
      }

      if (endTime < startTime) {
        const reason = "Trip end date must be on or after the start date.";
        setError(reason);
        return { ok: false, reason };
      }

      if (
        input.defaultFxRule === "fixed_trip" &&
        (input.fixedTripRate === null || !Number.isFinite(input.fixedTripRate) || input.fixedTripRate <= 0)
      ) {
        const reason = "Fixed trip rate must be a positive number.";
        setError(reason);
        return { ok: false, reason };
      }

      const creatorMemberId = makeId("member");
      const members = normalizeUniqueNames([input.creatorName, ...input.friendNames])
        .map((name, index) => ({
          id: index === 0 ? creatorMemberId : makeId("member"),
          name,
          active: true,
        }));

      if (members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) {
        const reason = `Settle supports ${MIN_MEMBERS} to ${MAX_MEMBERS} members per trip.`;
        setError(reason);
        return { ok: false, reason };
      }

      const trip = {
        ...defaultTrip(),
        creatorName: input.creatorName,
        name: input.tripName,
        startDate: input.startDate,
        endDate: input.endDate,
        settlementCurrency: input.settlementCurrency,
        defaultFxRule: input.defaultFxRule,
        fixedTripRate: input.fixedTripRate,
      };

      const created = createInitialState(repository.mode);
      const next: SettleState = {
        ...created,
        trip,
        activeMemberId: creatorMemberId,
        members,
      };

      setError(null);
      setState(next);
      void repository.save(next).catch((saveError: unknown) => {
        setError(saveError instanceof Error ? saveError.message : "Failed to save state");
      });
      return { ok: true, reason: null };
    },
    [repository],
  );

  const setActiveMember = useCallback(
    (memberId: string) => {
      updateState((previous) => ({
        ...previous,
        activeMemberId: memberId,
      }));
    },
    [updateState],
  );

  const addMember = useCallback(
    (name: string): ActionResult => {
      const actorId = state.activeMemberId;
      if (!state.trip || !actorId) {
        const reason = "Trip is not initialized.";
        setError(reason);
        return { ok: false, reason };
      }

      const trimmedName = name.trim();
      if (!trimmedName) {
        const reason = "Member name is required.";
        setError(reason);
        return { ok: false, reason };
      }

      if (state.members.length >= MAX_MEMBERS) {
        const reason = `Settle supports up to ${MAX_MEMBERS} members per trip.`;
        setError(reason);
        return { ok: false, reason };
      }

      const duplicate = state.members.some(
        (member) => member.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      );
      if (duplicate) {
        const reason = `Member '${trimmedName}' already exists.`;
        setError(reason);
        return { ok: false, reason };
      }

      const member = {
        id: makeId("member"),
        name: trimmedName,
        active: true,
      };

      updateState((previous) => {
        const nextMembers = [...previous.members, member];
        return withAudit(
          {
            ...previous,
            members: nextMembers,
          },
          actorId,
          "trip",
          previous.trip?.id ?? "trip",
          "trip.member_added",
          previous.members,
          nextMembers,
        );
      });

      setError(null);
      return { ok: true, reason: null };
    },
    [state.activeMemberId, state.members, state.trip, updateState],
  );

  const seedDemoTrip = useCallback(() => {
    const trip = {
      ...defaultTrip(),
      creatorName: "Demo Organizer",
      name: "Demo · Synthetic Group Trip",
      startDate: PILOT_START_DATE,
      endDate: PILOT_END_DATE,
      settlementCurrency: "INR",
      defaultFxRule: "posted" as FxRule,
      fixedTripRate: null,
    };

    const members = [
      { id: makeId("member"), name: "Member Alpha", active: true },
      { id: makeId("member"), name: "Member Beta", active: true },
      { id: makeId("member"), name: "Member Gamma", active: true },
    ];

    const [creatorMember] = members;
    const statementTransactions: StatementTransaction[] = [
      {
        id: makeId("txn"),
        sourceId: "src_demo_statement",
        sourceName: "demo-statement.txt",
        uploaderId: creatorMember.id,
        date: "2026-08-26",
        merchant: "Harbor Shuttle ZX-ALPHA",
        originalAmountMinor: 48000,
        originalCurrency: "IDR",
        postedAmountMinor: 2604,
        postedCurrency: "INR",
        inclusionState: "included",
        isCredit: false,
        isPayment: false,
        isFeeOrTax: false,
        fingerprint: "demo_fp_1",
        reference: "ZX-ALPHA-001",
        rawText: "260826 Harbor Shuttle ZX-ALPHA-001 IDR 48000.00 260.40",
        createdAt: nowIso(),
      },
      {
        id: makeId("txn"),
        sourceId: "src_demo_statement",
        sourceName: "demo-statement.txt",
        uploaderId: creatorMember.id,
        date: "2026-08-27",
        merchant: "Quay Commons Team Meal",
        originalAmountMinor: 320000,
        originalCurrency: "INR",
        postedAmountMinor: 320000,
        postedCurrency: "INR",
        inclusionState: "included",
        isCredit: false,
        isPayment: false,
        isFeeOrTax: false,
        fingerprint: "demo_fp_2",
        reference: "DINNER-42",
        rawText: "270826 Quay Commons Team Meal INR 3200.00",
        createdAt: nowIso(),
      },
      {
        id: makeId("txn"),
        sourceId: "src_demo_statement",
        sourceName: "demo-statement.txt",
        uploaderId: creatorMember.id,
        date: "2026-08-28",
        merchant: "Digital Wallet Payment",
        originalAmountMinor: 500000,
        originalCurrency: "INR",
        postedAmountMinor: 500000,
        postedCurrency: "INR",
        inclusionState: "excluded",
        isCredit: false,
        isPayment: true,
        isFeeOrTax: false,
        fingerprint: "demo_fp_3",
        reference: null,
        rawText: "280826 Digital Wallet Payment INR 5000.00",
        createdAt: nowIso(),
      },
      {
        id: makeId("txn"),
        sourceId: "src_demo_statement",
        sourceName: "demo-statement.txt",
        uploaderId: creatorMember.id,
        date: "2026-08-29",
        merchant: "Solo Scooter Night",
        originalAmountMinor: 12500,
        originalCurrency: "IDR",
        postedAmountMinor: 678,
        postedCurrency: "INR",
        inclusionState: "included",
        isCredit: false,
        isPayment: false,
        isFeeOrTax: false,
        fingerprint: "demo_fp_4",
        reference: "RIDE-9Y7K",
        rawText: "290826 Solo Scooter Night RIDE-9Y7K IDR 12500.00 67.81",
        createdAt: nowIso(),
      },
    ];

    const receipts = [
      parseReceiptText(
        [
          "Harbor Shuttle",
          "Booking: ZX-ALPHA-001",
          "Total Paid: Rp48.000",
          "Date: 2026-08-26",
        ].join("\n"),
        "demo-receipt-1.txt",
      ),
      parseReceiptText(
        [
          "Scooter Service",
          "Passenger: Member Alpha",
          "Profile: PERSONAL",
          "Service: Bike",
          "Paid: Rp12.500",
          "2026-08-29",
        ].join("\n"),
        "demo-receipt-2.txt",
      ),
    ];

    const teamMeal = statementTransactions[1];
    const shuttle = statementTransactions[0];
    const scooter = statementTransactions[3];
    const now = nowIso();

    const sharedSplit: SplitConfig = {
      participantIds: members.map((member) => member.id),
    };

    const teamMealExpense: Expense = {
      id: makeId("expense"),
      tripId: trip.id,
      title: teamMeal.merchant,
      date: teamMeal.date,
      payerId: creatorMember.id,
      settlementAmountMinor: teamMeal.postedAmountMinor ?? teamMeal.originalAmountMinor,
      settlementCurrency: trip.settlementCurrency,
      originalAmountMinor: teamMeal.originalAmountMinor,
      originalCurrency: teamMeal.originalCurrency,
      postedAmountMinor: teamMeal.postedAmountMinor,
      postedCurrency: teamMeal.postedCurrency,
      fxRule: "posted",
      fxRate: null,
      splitMode: "equal",
      splitConfig: sharedSplit,
      allocations: buildAllocations(
        teamMeal.postedAmountMinor ?? teamMeal.originalAmountMinor,
        "equal",
        sharedSplit,
        creatorMember.id,
      ),
      status: "approved",
      category: null,
      notes: "Demo shared dinner expense.",
      likelyPersonal: { likely: false, confidence: "low", reasons: [] },
      personalClassificationConfirmed: true,
      receiptMatch: null,
      evidence: {
        statementTransactionId: teamMeal.id,
        receiptId: null,
      },
      createdBy: creatorMember.id,
      approvedBy: creatorMember.id,
      approvedAt: now,
      reopenedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const shuttleExpense: Expense = {
      id: makeId("expense"),
      tripId: trip.id,
      title: shuttle.merchant,
      date: shuttle.date,
      payerId: members[1].id,
      settlementAmountMinor: shuttle.postedAmountMinor ?? 0,
      settlementCurrency: trip.settlementCurrency,
      originalAmountMinor: shuttle.originalAmountMinor,
      originalCurrency: shuttle.originalCurrency,
      postedAmountMinor: shuttle.postedAmountMinor,
      postedCurrency: shuttle.postedCurrency,
      fxRule: "posted",
      fxRate: null,
      splitMode: "equal",
      splitConfig: sharedSplit,
      allocations: buildAllocations(shuttle.postedAmountMinor ?? 0, "equal", sharedSplit, members[1].id),
      status: "approved",
      category: null,
      notes: "Demo shared transport expense.",
      likelyPersonal: { likely: false, confidence: "low", reasons: [] },
      personalClassificationConfirmed: true,
      receiptMatch: null,
      evidence: {
        statementTransactionId: shuttle.id,
        receiptId: receipts[0].id,
      },
      createdBy: members[1].id,
      approvedBy: creatorMember.id,
      approvedAt: now,
      reopenedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const likelyPersonal = detectLikelyPersonalExpense({
      merchant: scooter.merchant,
      description: scooter.rawText,
      receipt: receipts[1],
    });

    const personalExpense: Expense = {
      id: makeId("expense"),
      tripId: trip.id,
      title: scooter.merchant,
      date: scooter.date,
      payerId: creatorMember.id,
      settlementAmountMinor: scooter.postedAmountMinor ?? 0,
      settlementCurrency: trip.settlementCurrency,
      originalAmountMinor: scooter.originalAmountMinor,
      originalCurrency: scooter.originalCurrency,
      postedAmountMinor: scooter.postedAmountMinor,
      postedCurrency: scooter.postedCurrency,
      fxRule: "posted",
      fxRate: null,
      splitMode: "personal",
      splitConfig: { participantIds: [creatorMember.id] },
      allocations: buildAllocations(
        scooter.postedAmountMinor ?? 0,
        "personal",
        { participantIds: [creatorMember.id] },
        creatorMember.id,
      ),
      status: "draft",
      category: null,
      notes: "Demo likely-personal item pending confirmation.",
      likelyPersonal,
      personalClassificationConfirmed: false,
      receiptMatch: null,
      evidence: {
        statementTransactionId: scooter.id,
        receiptId: receipts[1].id,
      },
      createdBy: creatorMember.id,
      approvedBy: null,
      approvedAt: null,
      reopenedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const next: SettleState = {
      ...createInitialState(repository.mode),
      trip,
      activeMemberId: creatorMember.id,
      members,
      statementTransactions,
      receipts,
      expenses: [personalExpense, shuttleExpense, teamMealExpense],
    };

    setState(next);
    void repository.save(next).catch((saveError: unknown) => {
      setError(saveError instanceof Error ? saveError.message : "Failed to save demo state");
    });
    setError(null);
  }, [repository]);

  const importStatementText = useCallback(
    (text: string, sourceName: string): ImportResult => {
      if (!state.trip || !state.activeMemberId) {
        return { addedCount: 0, duplicateCount: 0 };
      }

      const parsed = parseStandardCharteredStatement({
        text,
        sourceName,
        uploaderId: state.activeMemberId,
        tripStartDate: state.trip.startDate,
        tripEndDate: state.trip.endDate,
      });

      let addedCount = 0;
      let duplicateCount = 0;

      updateState((previous) => {
        const seenFingerprints = new Set(
          previous.statementTransactions.map((transaction) => transaction.fingerprint),
        );
        const unique: StatementTransaction[] = [];

        for (const transaction of parsed) {
          if (seenFingerprints.has(transaction.fingerprint)) {
            duplicateCount += 1;
            continue;
          }

          seenFingerprints.add(transaction.fingerprint);
          unique.push(transaction);
        }

        addedCount = unique.length;

        return {
          ...previous,
          statementTransactions: [...unique, ...previous.statementTransactions],
        };
      });

      return { addedCount, duplicateCount };
    },
    [state.activeMemberId, state.trip, updateState],
  );

  const addSourceDraft = useCallback(
    (name: string, kind: "statement" | "receipt", reason: string) => {
      const actorId = state.activeMemberId;
      const draftId = makeId("draft");

      updateState((previous) => {
        const draft = {
          id: draftId,
          name,
          kind,
          reason,
          status: "needs_manual_review" as const,
          resolvedBy: null,
          resolvedAt: null,
          createdAt: nowIso(),
        };

        const withDraft = {
          ...previous,
          sourceDrafts: [draft, ...previous.sourceDrafts],
        };

        if (!actorId) {
          return withDraft;
        }

        return withAudit(
          withDraft,
          actorId,
          "source_draft",
          draft.id,
          "source_draft.added",
          null,
          draft,
        );
      });
      return draftId;
    },
    [state.activeMemberId, updateState],
  );

  const resolveSourceDraft = useCallback(
    (draftId: string) => {
      const actorId = state.activeMemberId;
      if (!actorId) {
        return false;
      }

      let resolved = false;
      updateState((previous) => {
        const draftIndex = previous.sourceDrafts.findIndex((draft) => draft.id === draftId);
        if (draftIndex < 0) {
          return previous;
        }

        const before = previous.sourceDrafts[draftIndex];
        if (before.status === "resolved") {
          return previous;
        }

        const updated = {
          ...before,
          status: "resolved" as const,
          resolvedBy: actorId,
          resolvedAt: nowIso(),
        };
        const nextDrafts = [...previous.sourceDrafts];
        nextDrafts[draftIndex] = updated;
        resolved = true;

        return withAudit(
          {
            ...previous,
            sourceDrafts: nextDrafts,
          },
          actorId,
          "source_draft",
          draftId,
          "source_draft.resolved",
          before,
          updated,
        );
      });

      if (resolved) {
        setError(null);
      }

      return resolved;
    },
    [state.activeMemberId, updateState],
  );

  const removeSourceDraft = useCallback(
    (draftId: string) => {
      const actorId = state.activeMemberId;
      if (!actorId) {
        return false;
      }

      let removed = false;
      updateState((previous) => {
        const draftIndex = previous.sourceDrafts.findIndex((draft) => draft.id === draftId);
        if (draftIndex < 0) {
          return previous;
        }

        const before = previous.sourceDrafts[draftIndex];
        const nextDrafts = previous.sourceDrafts.filter((draft) => draft.id !== draftId);
        removed = true;

        return withAudit(
          {
            ...previous,
            sourceDrafts: nextDrafts,
          },
          actorId,
          "source_draft",
          draftId,
          "source_draft.removed",
          before,
          null,
        );
      });

      if (removed) {
        setError(null);
      }

      return removed;
    },
    [state.activeMemberId, updateState],
  );

  const addReceipt = useCallback(
    (receipt: ReceiptEvidence) => {
      updateState((previous) => ({
        ...previous,
        receipts: [receipt, ...previous.receipts],
      }));
    },
    [updateState],
  );

  const addReceiptFromText = useCallback(
    (text: string, sourceName: string) => {
      const receipt = parseReceiptText(text, sourceName);
      addReceipt(receipt);
      return receipt;
    },
    [addReceipt],
  );

  const setTransactionInclusion = useCallback(
    (transactionId: string, inclusionState: "included" | "excluded"): ActionResult => {
      const actorId = state.activeMemberId;
      if (!actorId) {
        const reason = "No active member";
        setError(reason);
        return { ok: false, reason };
      }

      let changed = false;
      updateState((previous) => {
        const index = previous.statementTransactions.findIndex(
          (transaction) => transaction.id === transactionId,
        );
        if (index < 0) {
          return previous;
        }

        const before = previous.statementTransactions[index];
        const updated = {
          ...before,
          inclusionState,
        };
        changed = true;

        const nextTransactions = [...previous.statementTransactions];
        nextTransactions[index] = updated;

        return withAudit(
          {
            ...previous,
            statementTransactions: nextTransactions,
          },
          actorId,
          "transaction",
          transactionId,
          "transaction.inclusion_changed",
          before,
          updated,
        );
      });

      if (!changed) {
        const reason = "Transaction not found.";
        setError(reason);
        return { ok: false, reason };
      }

      setError(null);
      return { ok: true, reason: null };
    },
    [state.activeMemberId, updateState],
  );

  const excludeTransaction = useCallback(
    (transactionId: string): ExcludeTransactionResult => {
      const actorId = state.activeMemberId;
      if (!actorId) {
        const reason = "No active member";
        setError(reason);
        return { ok: false, reason, removedExpense: null, removedComments: [] };
      }

      const plannedMutation = excludeTransactionWithLinkedDraft(
        state.statementTransactions,
        state.expenses,
        state.comments,
        transactionId,
      );
      if (!plannedMutation.ok) {
        const reason = plannedMutation.error ?? "Could not exclude transaction.";
        setError(reason);
        return {
          ok: false,
          reason,
          removedExpense: null,
          removedComments: [],
        };
      }

      updateState((previous) => {
        const mutation = excludeTransactionWithLinkedDraft(
          previous.statementTransactions,
          previous.expenses,
          previous.comments,
          transactionId,
        );

        if (!mutation.ok) {
          return previous;
        }

        const beforeTransaction = previous.statementTransactions.find(
          (transaction) => transaction.id === transactionId,
        );
        const afterTransaction = mutation.transactions.find(
          (transaction) => transaction.id === transactionId,
        );
        if (!beforeTransaction || !afterTransaction) {
          return previous;
        }

        let next = invalidateSnapshot({
          ...previous,
          statementTransactions: mutation.transactions,
          expenses: mutation.expenses,
          comments: mutation.comments,
        });

        next = withAudit(
          next,
          actorId,
          "transaction",
          transactionId,
          "transaction.excluded",
          beforeTransaction,
          afterTransaction,
        );

        if (mutation.removedExpense) {
          next = withAudit(
            next,
            actorId,
            "expense",
            mutation.removedExpense.id,
            "expense.removed_for_transaction_exclusion",
            mutation.removedExpense,
            null,
          );
        }

        return next;
      });

      setError(null);
      return {
        ok: true,
        reason: null,
        removedExpense: plannedMutation.removedExpense,
        removedComments: plannedMutation.removedComments,
      };
    },
    [state.activeMemberId, state.comments, state.expenses, state.statementTransactions, updateState],
  );

  const includeTransaction = useCallback(
    (transactionId: string, options?: IncludeTransactionOptions): ActionResult => {
      const actorId = state.activeMemberId;
      if (!actorId) {
        const reason = "No active member";
        setError(reason);
        return { ok: false, reason };
      }

      const plannedMutation = includeTransactionWithRestore(
        state.statementTransactions,
        state.expenses,
        state.comments,
        transactionId,
        {
          expense: options?.restoreExpense ?? null,
          comments: options?.restoreComments ?? [],
        },
      );
      if (!plannedMutation.ok) {
        const reason = plannedMutation.error ?? "Could not include transaction.";
        setError(reason);
        return { ok: false, reason };
      }

      updateState((previous) => {
        const mutation = includeTransactionWithRestore(
          previous.statementTransactions,
          previous.expenses,
          previous.comments,
          transactionId,
          {
            expense: options?.restoreExpense ?? null,
            comments: options?.restoreComments ?? [],
          },
        );

        if (!mutation.ok) {
          return previous;
        }

        const beforeTransaction = previous.statementTransactions.find(
          (transaction) => transaction.id === transactionId,
        );
        const afterTransaction = mutation.transactions.find(
          (transaction) => transaction.id === transactionId,
        );
        if (!beforeTransaction || !afterTransaction) {
          return previous;
        }

        let next = invalidateSnapshot({
          ...previous,
          statementTransactions: mutation.transactions,
          expenses: mutation.expenses,
          comments: mutation.comments,
        });

        next = withAudit(
          next,
          actorId,
          "transaction",
          transactionId,
          "transaction.included",
          beforeTransaction,
          afterTransaction,
        );

        if (mutation.restoredExpense && options?.restoreExpense) {
          next = withAudit(
            next,
            actorId,
            "expense",
            options.restoreExpense.id,
            "expense.restored_after_transaction_include",
            null,
            options.restoreExpense,
          );
        }

        return next;
      });

      setError(null);
      return { ok: true, reason: null };
    },
    [state.activeMemberId, state.comments, state.expenses, state.statementTransactions, updateState],
  );

  const addManualExpense = useCallback(
    (input: ManualExpenseInput) => {
      const actorId = state.activeMemberId;
      if (!state.trip || !actorId) {
        return;
      }

      const likelyPersonal = detectLikelyPersonalExpense({
        merchant: input.title,
        description: input.notes,
      });

      const splitMode: SplitMode =
        likelyPersonal.likely && input.splitMode === "equal" ? "personal" : input.splitMode;
      const splitConfig: SplitConfig =
        splitMode === "personal"
          ? { participantIds: [input.payerId] }
          : {
              ...input.splitConfig,
              participantIds: input.splitConfig.participantIds,
            };

      const allocations = buildAllocations(
        input.settlementAmountMinor,
        splitMode,
        splitConfig,
        input.payerId,
      );

      const expense: Expense = {
        id: makeId("expense"),
        tripId: state.trip.id,
        title: input.title,
        date: input.date,
        payerId: input.payerId,
        settlementAmountMinor: input.settlementAmountMinor,
        settlementCurrency: state.trip.settlementCurrency,
        originalAmountMinor: input.settlementAmountMinor,
        originalCurrency: state.trip.settlementCurrency,
        postedAmountMinor: input.settlementAmountMinor,
        postedCurrency: state.trip.settlementCurrency,
        fxRule: state.trip.defaultFxRule,
        fxRate: state.trip.defaultFxRule === "fixed_trip" ? state.trip.fixedTripRate : 1,
        splitMode,
        splitConfig,
        allocations,
        status: "draft",
        category: null,
        notes: input.notes,
        likelyPersonal,
        personalClassificationConfirmed: !likelyPersonal.likely || splitMode !== "personal",
        receiptMatch: null,
        evidence: {
          statementTransactionId: null,
          receiptId: null,
        },
        createdBy: actorId,
        approvedBy: null,
        approvedAt: null,
        reopenedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      updateState((previous) => {
        const withExpense = {
          ...previous,
          expenses: [expense, ...previous.expenses],
        };

        const invalidated = invalidateSnapshot(withExpense);
        return withAudit(
          invalidated,
          actorId,
          "expense",
          expense.id,
          "expense.created",
          null,
          expense,
        );
      });

      setError(null);
    },
    [state.activeMemberId, state.trip, updateState],
  );

  const createExpenseFromTransaction = useCallback(
    (transactionId: string, receiptId: string | null) => {
      const actorId = state.activeMemberId;
      if (!state.trip || !actorId) {
        return;
      }

      const transaction = state.statementTransactions.find((row) => row.id === transactionId);
      if (!transaction || transaction.inclusionState !== "included") {
        return;
      }

      const existing = state.expenses.find(
        (expense) => expense.evidence.statementTransactionId === transactionId,
      );
      if (existing) {
        return;
      }

      const receipt = receiptId
        ? state.receipts.find((entry) => entry.id === receiptId) ?? null
        : null;

      const matchSuggestion = receipt
        ? suggestReceiptMatches(receipt, [transaction])[0] ?? null
        : null;

      const resolved = resolveSettlementAmountFromTransaction(transaction, state.trip);
      const likelyPersonal = detectLikelyPersonalExpense({
        merchant: transaction.merchant,
        description: transaction.rawText,
        receipt,
      });

      const splitMode: SplitMode = likelyPersonal.likely ? "personal" : "equal";
      const splitConfig: SplitConfig =
        splitMode === "personal"
          ? { participantIds: [actorId] }
          : {
              participantIds: state.members.map((member) => member.id),
            };
      const allocations = buildAllocations(
        resolved.settlementAmountMinor,
        splitMode,
        splitConfig,
        actorId,
      );

      const expense: Expense = {
        id: makeId("expense"),
        tripId: state.trip.id,
        title: transaction.merchant,
        date: transaction.date,
        payerId: actorId,
        settlementAmountMinor: resolved.settlementAmountMinor,
        settlementCurrency: state.trip.settlementCurrency,
        originalAmountMinor: transaction.originalAmountMinor,
        originalCurrency: transaction.originalCurrency,
        postedAmountMinor: transaction.postedAmountMinor,
        postedCurrency: transaction.postedCurrency,
        fxRule: resolved.fxRule,
        fxRate: resolved.fxRate,
        splitMode,
        splitConfig,
        allocations,
        status: "draft",
        category: transaction.isFeeOrTax ? "fee_or_tax" : null,
        notes: transaction.isFeeOrTax ? "Imported fee/tax row, review before approval." : "",
        likelyPersonal,
        personalClassificationConfirmed: !likelyPersonal.likely,
        receiptMatch: matchSuggestion,
        evidence: {
          statementTransactionId: transactionId,
          receiptId: receipt?.id ?? null,
        },
        createdBy: actorId,
        approvedBy: null,
        approvedAt: null,
        reopenedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      updateState((previous) => {
        const withExpense = {
          ...previous,
          expenses: [expense, ...previous.expenses],
        };

        const invalidated = invalidateSnapshot(withExpense);
        return withAudit(
          invalidated,
          actorId,
          "expense",
          expense.id,
          "expense.created_from_transaction",
          null,
          expense,
        );
      });
    },
    [state.activeMemberId, state.expenses, state.members, state.receipts, state.statementTransactions, state.trip, updateState],
  );

  const updateExpenseDraft = useCallback(
    (input: UpdateExpenseInput) => {
      const actorId = state.activeMemberId;
      if (!actorId) {
        return;
      }

      updateState((previous) => {
        const index = previous.expenses.findIndex((expense) => expense.id === input.expenseId);
        if (index < 0) {
          return previous;
        }

        const before = previous.expenses[index];
        const receipt = before.evidence.receiptId
          ? previous.receipts.find((entry) => entry.id === before.evidence.receiptId) ?? null
          : null;

        const likelyPersonal = detectLikelyPersonalExpense({
          merchant: input.title,
          description: input.notes,
          receipt,
        });

        const fxChanged = input.fxRule !== before.fxRule || input.fxRate !== before.fxRate;
        const recomputedByFxChange =
          fxChanged && previous.trip
            ? recomputeSettlementAmountForExpense(before, previous.trip, input.fxRule, input.fxRate)
            : null;
        const settlementAmountMinor = recomputedByFxChange ?? input.settlementAmountMinor;

        const personalClassificationConfirmed =
          !likelyPersonal.likely ||
          input.splitMode !== "personal" ||
          before.personalClassificationConfirmed;

        const allocations = buildAllocations(
          settlementAmountMinor,
          input.splitMode,
          input.splitConfig,
          input.payerId,
        );

        const updated: Expense = {
          ...before,
          title: input.title,
          date: input.date,
          payerId: input.payerId,
          settlementAmountMinor,
          splitMode: input.splitMode,
          splitConfig: input.splitConfig,
          allocations,
          notes: input.notes,
          fxRule: input.fxRule,
          fxRate: input.fxRate,
          likelyPersonal,
          personalClassificationConfirmed,
          status: before.status === "approved" ? "reopened" : before.status,
          approvedBy: before.status === "approved" ? null : before.approvedBy,
          approvedAt: before.status === "approved" ? null : before.approvedAt,
          reopenedAt: before.status === "approved" ? nowIso() : before.reopenedAt,
          updatedAt: nowIso(),
        };

        const nextExpenses = [...previous.expenses];
        nextExpenses[index] = updated;

        const invalidated = invalidateSnapshot({
          ...previous,
          expenses: nextExpenses,
        });

        return withAudit(
          invalidated,
          actorId,
          "expense",
          updated.id,
          "expense.updated",
          before,
          updated,
        );
      });

      setError(null);
    },
    [state.activeMemberId, updateState],
  );

  const approveExpense = useCallback(
    (expenseId: string) => {
      const actorId = state.activeMemberId;
      if (!actorId) {
        return false;
      }

      const target = state.expenses.find((expense) => expense.id === expenseId);
      if (!target) {
        return false;
      }

      const targetForApproval =
        target.likelyPersonal.likely &&
        target.splitMode === "personal" &&
        !target.personalClassificationConfirmed
          ? { ...target, personalClassificationConfirmed: true }
          : target;
      const approval = canApproveExpense(targetForApproval);
      if (!approval.ok) {
        setError(approval.reason);
        return false;
      }

      updateState((previous) => {
        const index = previous.expenses.findIndex((expense) => expense.id === expenseId);
        if (index < 0) {
          return previous;
        }

        const before = previous.expenses[index];
        const updated: Expense = {
          ...before,
          personalClassificationConfirmed:
            before.personalClassificationConfirmed ||
            (before.likelyPersonal.likely && before.splitMode === "personal"),
          status: "approved",
          approvedBy: actorId,
          approvedAt: nowIso(),
          reopenedAt: null,
          updatedAt: nowIso(),
        };

        const nextExpenses = [...previous.expenses];
        nextExpenses[index] = updated;

        const invalidated = invalidateSnapshot({
          ...previous,
          expenses: nextExpenses,
        });

        return withAudit(
          invalidated,
          actorId,
          "expense",
          updated.id,
          "expense.approved",
          before,
          updated,
        );
      });

      setError(null);
      return true;
    },
    [state.activeMemberId, state.expenses, updateState],
  );

  const confirmPersonalClassification = useCallback(
    (expenseId: string) => {
      const actorId = state.activeMemberId;
      if (!actorId) {
        return;
      }

      updateState((previous) => {
        const expenseIndex = previous.expenses.findIndex((expense) => expense.id === expenseId);
        if (expenseIndex < 0) {
          return previous;
        }

        const before = previous.expenses[expenseIndex];
        if (!before.likelyPersonal.likely || before.personalClassificationConfirmed) {
          return previous;
        }

        const updated: Expense = {
          ...before,
          personalClassificationConfirmed: true,
          updatedAt: nowIso(),
        };

        const nextExpenses = [...previous.expenses];
        nextExpenses[expenseIndex] = updated;

        return withAudit(
          {
            ...previous,
            expenses: nextExpenses,
          },
          actorId,
          "expense",
          updated.id,
          "expense.personal_classification_confirmed",
          before,
          updated,
        );
      });
      setError(null);
    },
    [state.activeMemberId, updateState],
  );

  const reopenExpense = useCallback(
    (expenseId: string, reason: string) => {
      const actorId = state.activeMemberId;
      if (!actorId) {
        return;
      }

      updateState((previous) => {
        const expenseIndex = previous.expenses.findIndex((expense) => expense.id === expenseId);
        if (expenseIndex < 0) {
          return previous;
        }

        const before = previous.expenses[expenseIndex];
        const updated: Expense = {
          ...before,
          status: "reopened",
          reopenedAt: nowIso(),
          updatedAt: nowIso(),
        };

        const comment: ExpenseComment = {
          id: makeId("comment"),
          expenseId,
          memberId: actorId,
          body: reason,
          createdAt: nowIso(),
        };

        const nextExpenses = [...previous.expenses];
        nextExpenses[expenseIndex] = updated;

        const invalidated = invalidateSnapshot({
          ...previous,
          expenses: nextExpenses,
          comments: [comment, ...previous.comments],
        });

        return withAudit(
          invalidated,
          actorId,
          "expense",
          updated.id,
          "expense.reopened",
          before,
          updated,
        );
      });
    },
    [state.activeMemberId, updateState],
  );

  const addComment = useCallback(
    (expenseId: string, body: string) => {
      const actorId = state.activeMemberId;
      if (!actorId || !body.trim()) {
        return;
      }

      updateState((previous) => ({
        ...previous,
        comments: [
          {
            id: makeId("comment"),
            expenseId,
            memberId: actorId,
            body: body.trim(),
            createdAt: nowIso(),
          },
          ...previous.comments,
        ],
      }));
    },
    [state.activeMemberId, updateState],
  );

  const lockSnapshot = useCallback(() => {
    const actorId = state.activeMemberId;
    if (!actorId) {
      return { ok: false, reason: "No active member" };
    }

    const blockers = buildLockBlockers(state);
    if (blockers.pendingExpenses > 0) {
      return { ok: false, reason: "Review queue is not empty" };
    }
    if (blockers.unlinkedIncludedTransactions > 0) {
      return { ok: false, reason: "Some included statement transactions are not linked to expenses" };
    }
    if (blockers.pendingSourceDrafts > 0) {
      return { ok: false, reason: "Some source imports still require manual review" };
    }
    if (blockers.unconfirmedPersonalExpenses > 0) {
      return {
        ok: false,
        reason: "At least one approved likely-personal expense is unconfirmed",
      };
    }

    const computed = recomputeLedgers(state);
    const snapshot: SettlementSnapshot = {
      id: makeId("snapshot"),
      createdBy: actorId,
      createdAt: nowIso(),
      memberLedgers: computed.ledgers,
      transfers: computed.transfers,
      totalSpendMinor: computed.total,
    };

    updateState((previous) =>
      withAudit(
        {
          ...previous,
          snapshot,
        },
        actorId,
        "trip",
        previous.trip?.id ?? "trip",
        "trip.locked",
        previous.snapshot,
        snapshot,
      ),
    );

    setError(null);
    return { ok: true, reason: null };
  }, [state, updateState]);

  const resetAll = useCallback(() => {
    const next = createInitialState(repository.mode);
    setState(next);
    void repository.save(next).catch((saveError: unknown) => {
      setError(saveError instanceof Error ? saveError.message : "Failed to reset state");
    });
  }, [repository]);

  const attachReceiptToExpense = useCallback(
    (expenseId: string, receiptId: string) => {
      const actorId = state.activeMemberId;
      if (!actorId) {
        return;
      }

      updateState((previous) => {
        const expenseIndex = previous.expenses.findIndex((expense) => expense.id === expenseId);
        if (expenseIndex < 0) {
          return previous;
        }

        const before = previous.expenses[expenseIndex];
        const receipt = previous.receipts.find((entry) => entry.id === receiptId);
        if (!receipt) {
          return previous;
        }

        const transaction = before.evidence.statementTransactionId
          ? previous.statementTransactions.find(
              (entry) => entry.id === before.evidence.statementTransactionId,
            ) ?? null
          : null;

        const match = transaction ? suggestReceiptMatches(receipt, [transaction])[0] ?? null : null;
        const likelyPersonal = detectLikelyPersonalExpense({
          merchant: before.title,
          description: before.notes,
          receipt,
        });

        const updated: Expense = {
          ...before,
          evidence: {
            ...before.evidence,
            receiptId,
          },
          receiptMatch: match,
          likelyPersonal,
          personalClassificationConfirmed:
            !likelyPersonal.likely || before.splitMode !== "personal" || before.personalClassificationConfirmed,
          status: before.status === "approved" ? "reopened" : before.status,
          approvedBy: before.status === "approved" ? null : before.approvedBy,
          approvedAt: before.status === "approved" ? null : before.approvedAt,
          reopenedAt: before.status === "approved" ? nowIso() : before.reopenedAt,
          updatedAt: nowIso(),
        };

        const nextExpenses = [...previous.expenses];
        nextExpenses[expenseIndex] = updated;

        const invalidated = invalidateSnapshot({
          ...previous,
          expenses: nextExpenses,
        });

        return withAudit(
          invalidated,
          actorId,
          "expense",
          expenseId,
          "expense.receipt_attached",
          before,
          updated,
        );
      });
    },
    [state.activeMemberId, updateState],
  );

  const derived = useMemo(() => {
    const approvedExpenses = state.expenses.filter((expense) => expense.status === "approved");
    const pendingExpenses = state.expenses.filter((expense) => expense.status !== "approved");
    const lockBlockers = buildLockBlockers(state);
    const linkedTransactionIds = new Set(
      state.expenses
        .map((expense) => expense.evidence.statementTransactionId)
        .filter((value): value is string => Boolean(value)),
    );

    let ledgers: MemberLedger[] = [];
    let transfers: Transfer[] = [];
    let transferStrategy: "exact" | "simplified" = "exact";
    let totalSpendMinor = 0;
    try {
      const result = recomputeLedgers(state);
      ledgers = result.ledgers;
      transfers = result.transfers;
      transferStrategy = result.transferStrategy;
      totalSpendMinor = result.total;
    } catch {
      ledgers = state.members.map((member) => ({
        memberId: member.id,
        paidMinor: 0,
        owedMinor: 0,
        balanceMinor: 0,
      }));
      transfers = [];
      transferStrategy = "exact";
      totalSpendMinor = 0;
    }

    const importReviewQueue = state.statementTransactions
      .filter((row) => row.uploaderId === state.activeMemberId)
      .sort((left, right) => right.date.localeCompare(left.date));

    const suggestedMatches = state.receipts
      .map((receipt) => {
        const matches = suggestReceiptMatches(receipt, state.statementTransactions, {
          isEligible: (transaction) =>
            transaction.inclusionState === "included" &&
            !transaction.isPayment &&
            !linkedTransactionIds.has(transaction.id),
        });
        return {
          receipt,
          match: matches[0] ?? null,
          dateDistance:
            receipt.date && matches[0]
              ? dayDistance(
                  receipt.date,
                  state.statementTransactions.find((row) => row.id === matches[0]?.transactionId)?.date ??
                    receipt.date,
                )
              : null,
        };
      })
      .filter((entry) => entry.match !== null)
      .sort((left, right) => (right.match?.score ?? 0) - (left.match?.score ?? 0));

    return {
      approvedExpenses,
      pendingExpenses,
      ledgers,
      transfers,
      transferStrategy,
      totalSpendMinor,
      importReviewQueue,
      suggestedMatches,
      lockBlockers,
    };
  }, [state]);

  return {
    ready,
    error,
    state,
    derived,
    actions: {
      createTrip,
      seedDemoTrip,
      setActiveMember,
      addMember,
      importStatementText,
      addSourceDraft,
      resolveSourceDraft,
      removeSourceDraft,
      addReceiptFromText,
      setTransactionInclusion,
      excludeTransaction,
      includeTransaction,
      addManualExpense,
      createExpenseFromTransaction,
      updateExpenseDraft,
      approveExpense,
      confirmPersonalClassification,
      reopenExpense,
      addComment,
      lockSnapshot,
      resetAll,
      attachReceiptToExpense,
    },
  };
}
