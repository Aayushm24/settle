export type RepositoryMode = "local";

export type FxRule = "posted" | "daily_market" | "fixed_trip";

export type SplitMode = "equal" | "exact" | "weighted" | "personal";

export type Confidence = "low" | "medium" | "high";

export type InclusionState = "included" | "excluded";

export interface Trip {
  id: string;
  creatorName: string;
  name: string;
  startDate: string;
  endDate: string;
  settlementCurrency: string;
  defaultFxRule: FxRule;
  fixedTripRate: number | null;
  createdAt: string;
}

export interface Member {
  id: string;
  name: string;
  active: boolean;
}

export interface StatementTransaction {
  id: string;
  sourceId: string;
  sourceName: string;
  uploaderId: string;
  date: string;
  merchant: string;
  originalAmountMinor: number;
  originalCurrency: string;
  postedAmountMinor: number | null;
  postedCurrency: string | null;
  inclusionState: InclusionState;
  isCredit: boolean;
  isPayment: boolean;
  isFeeOrTax: boolean;
  fingerprint: string;
  reference: string | null;
  rawText: string;
  createdAt: string;
}

export interface ReceiptEvidence {
  id: string;
  sourceId: string;
  sourceName: string;
  date: string | null;
  merchant: string;
  totalAmountMinor: number;
  currency: string;
  bookingIds: string[];
  passengerName: string | null;
  profile: string | null;
  service: string | null;
  text: string;
  createdAt: string;
}

export interface LikelyPersonalFlag {
  likely: boolean;
  confidence: Confidence;
  reasons: string[];
}

export interface ReceiptMatchSuggestion {
  transactionId: string;
  score: number;
  confidence: Confidence;
  evidence: string[];
}

export interface ExpenseAllocation {
  memberId: string;
  amountMinor: number;
}

export interface SplitConfig {
  participantIds: string[];
  exactAmountByMemberId?: Record<string, number>;
  weightByMemberId?: Record<string, number>;
}

export type ExpenseStatus = "draft" | "approved" | "reopened";

export interface Expense {
  id: string;
  tripId: string;
  title: string;
  date: string;
  payerId: string;
  settlementAmountMinor: number;
  settlementCurrency: string;
  originalAmountMinor: number | null;
  originalCurrency: string | null;
  postedAmountMinor: number | null;
  postedCurrency: string | null;
  fxRule: FxRule;
  fxRate: number | null;
  splitMode: SplitMode;
  splitConfig: SplitConfig;
  allocations: ExpenseAllocation[];
  status: ExpenseStatus;
  category: string | null;
  notes: string;
  likelyPersonal: LikelyPersonalFlag;
  personalClassificationConfirmed: boolean;
  receiptMatch: ReceiptMatchSuggestion | null;
  evidence: {
    statementTransactionId: string | null;
    receiptId: string | null;
  };
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  reopenedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseComment {
  id: string;
  expenseId: string;
  memberId: string;
  body: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorId: string;
  entityType: "expense" | "trip" | "transaction" | "source_draft";
  entityId: string;
  eventType: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface MemberLedger {
  memberId: string;
  paidMinor: number;
  owedMinor: number;
  balanceMinor: number;
}

export interface Transfer {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
}

export interface SettlementSnapshot {
  id: string;
  createdBy: string;
  createdAt: string;
  memberLedgers: MemberLedger[];
  transfers: Transfer[];
  totalSpendMinor: number;
}

export interface SourceDocumentDraft {
  id: string;
  name: string;
  kind: "statement" | "receipt";
  status: "needs_manual_review" | "resolved";
  reason: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SettleState {
  version: 1;
  mode: RepositoryMode;
  trip: Trip | null;
  activeMemberId: string | null;
  members: Member[];
  statementTransactions: StatementTransaction[];
  receipts: ReceiptEvidence[];
  expenses: Expense[];
  comments: ExpenseComment[];
  auditEvents: AuditEvent[];
  snapshot: SettlementSnapshot | null;
  sourceDrafts: SourceDocumentDraft[];
}
