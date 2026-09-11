"use client";

import { ChangeEvent, FormEvent, useMemo, useState } from "react";

import { buildSettlementCsv } from "@/lib/export";
import {
  parseAmountToMinorUnits,
  formatMinorUnits,
  fromMinorUnits,
  getCurrencyScale,
} from "@/lib/money";
import { isSourceDraftUnresolved } from "@/lib/source-draft-policy";
import { validateUpload } from "@/lib/upload-validation";
import { useSettle } from "@/lib/use-settle";
import {
  FxRule,
  Member,
  SplitConfig,
  SplitMode,
  Expense,
  Transfer,
  MemberLedger,
} from "@/lib/types";
import {
  DEFAULT_FX_RULE,
  DEFAULT_SETTLEMENT_CURRENCY,
  PILOT_END_DATE,
  PILOT_START_DATE,
} from "@/lib/constants";

type AppTab = "dashboard" | "review" | "expenses" | "settlement" | "settings";

interface SetupFormState {
  creatorName: string;
  tripName: string;
  startDate: string;
  endDate: string;
  settlementCurrency: string;
  defaultFxRule: FxRule;
  fixedTripRate: string;
  friendNamesText: string;
}

interface ManualFormState {
  title: string;
  date: string;
  payerId: string;
  amount: string;
  splitMode: SplitMode;
  participantIds: string[];
  notes: string;
  exactByMemberId: Record<string, string>;
  weightByMemberId: Record<string, string>;
}

function badgeClass(confidence: "low" | "medium" | "high"): string {
  if (confidence === "high") {
    return "bg-emerald-100 text-emerald-800 border-emerald-200";
  }
  if (confidence === "medium") {
    return "bg-amber-100 text-amber-800 border-amber-200";
  }
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function makeSplitConfig(form: ManualFormState, settlementCurrency: string): SplitConfig {
  if (form.splitMode === "exact") {
    return {
      participantIds: form.participantIds,
      exactAmountByMemberId: Object.fromEntries(
        form.participantIds.map((memberId) => {
          const raw = form.exactByMemberId[memberId] ?? "0";
          return [memberId, parseAmountToMinorUnits(raw, settlementCurrency)];
        }),
      ),
    };
  }

  if (form.splitMode === "weighted") {
    return {
      participantIds: form.participantIds,
      weightByMemberId: Object.fromEntries(
        form.participantIds.map((memberId) => {
          const raw = form.weightByMemberId[memberId] ?? "1";
          const weight = Number.parseInt(raw, 10);
          return [memberId, Number.isFinite(weight) && weight > 0 ? weight : 1];
        }),
      ),
    };
  }

  return { participantIds: form.participantIds };
}

function memberName(members: Member[], memberId: string): string {
  return members.find((member) => member.id === memberId)?.name ?? memberId;
}

function downloadSettlementCsv(
  tripCurrency: string,
  members: Member[],
  ledgers: MemberLedger[],
  transfers: Transfer[],
) {
  const csv = buildSettlementCsv(tripCurrency, members, ledgers, transfers);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "settlement-summary.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const { ready, state, derived, actions, error } = useSettle();
  const [tab, setTab] = useState<AppTab>("dashboard");
  const [showAdd, setShowAdd] = useState(false);
  const [status, setStatus] = useState<string>("");

  const [setupForm, setSetupForm] = useState<SetupFormState>({
    creatorName: "",
    tripName: "Bali Trip",
    startDate: PILOT_START_DATE,
    endDate: PILOT_END_DATE,
    settlementCurrency: DEFAULT_SETTLEMENT_CURRENCY,
    defaultFxRule: DEFAULT_FX_RULE,
    fixedTripRate: "",
    friendNamesText: "",
  });

  const [statementText, setStatementText] = useState("");
  const [receiptText, setReceiptText] = useState("");

  const defaultParticipants = useMemo(
    () => state.members.map((member) => member.id),
    [state.members],
  );

  const [manualForm, setManualForm] = useState<ManualFormState>({
    title: "",
    date: state.trip?.startDate ?? PILOT_START_DATE,
    payerId: state.activeMemberId ?? "",
    amount: "",
    splitMode: "equal",
    participantIds: defaultParticipants,
    notes: "",
    exactByMemberId: {},
    weightByMemberId: {},
  });

  const [activeExpenseId, setActiveExpenseId] = useState<string | null>(null);
  const [reopenNoteByExpenseId, setReopenNoteByExpenseId] = useState<Record<string, string>>({});
  const [commentDraftByExpenseId, setCommentDraftByExpenseId] = useState<Record<string, string>>({});

  const effectiveManualParticipants =
    manualForm.participantIds.length > 0 ? manualForm.participantIds : defaultParticipants;
  const effectiveManualPayerId =
    manualForm.payerId || state.activeMemberId || state.members[0]?.id || "";
  const effectiveManualDate = manualForm.date || state.trip?.startDate || PILOT_START_DATE;

  if (!ready) {
    return <main className="p-8 text-slate-700">Loading Settle...</main>;
  }

  if (!state.trip) {
    return (
      <main className="min-h-screen bg-[#f6f7f5] p-6 text-slate-900 md:p-12">
        <section className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
          <h1 className="text-3xl font-semibold tracking-tight">Create your trip ledger</h1>
          <p className="mt-3 text-slate-600">
            Settle starts directly in trip setup. Default pilot range is prefilled and editable.
          </p>

          <form
            className="mt-8 grid gap-5"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (!setupForm.creatorName.trim() || !setupForm.tripName.trim()) {
                setStatus("Creator and trip name are required.");
                return;
              }

              const uniqueNames = new Set(
                [setupForm.creatorName, ...setupForm.friendNamesText.split(",")]
                  .map((name) => name.trim().toLowerCase())
                  .filter(Boolean),
              );
              if (uniqueNames.size < 2 || uniqueNames.size > 10) {
                setStatus("Trips must include between 2 and 10 unique members.");
                return;
              }

              actions.createTrip({
                creatorName: setupForm.creatorName.trim(),
                tripName: setupForm.tripName.trim(),
                startDate: setupForm.startDate,
                endDate: setupForm.endDate,
                settlementCurrency: setupForm.settlementCurrency.toUpperCase(),
                defaultFxRule: setupForm.defaultFxRule,
                fixedTripRate:
                  setupForm.defaultFxRule === "fixed_trip" && setupForm.fixedTripRate
                    ? Number.parseFloat(setupForm.fixedTripRate)
                    : null,
                friendNames: setupForm.friendNamesText
                  .split(",")
                  .map((name) => name.trim())
                  .filter(Boolean),
              });
            }}
          >
            <label className="grid gap-2">
              <span className="text-sm font-medium">Your name</span>
              <input
                className="rounded-xl border border-slate-300 px-3 py-2"
                value={setupForm.creatorName}
                onChange={(event) =>
                  setSetupForm((previous) => ({
                    ...previous,
                    creatorName: event.target.value,
                  }))
                }
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium">Trip name</span>
              <input
                className="rounded-xl border border-slate-300 px-3 py-2"
                value={setupForm.tripName}
                onChange={(event) =>
                  setSetupForm((previous) => ({
                    ...previous,
                    tripName: event.target.value,
                  }))
                }
                required
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium">Start date</span>
                <input
                  type="date"
                  className="rounded-xl border border-slate-300 px-3 py-2"
                  value={setupForm.startDate}
                  onChange={(event) =>
                    setSetupForm((previous) => ({
                      ...previous,
                      startDate: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium">End date</span>
                <input
                  type="date"
                  className="rounded-xl border border-slate-300 px-3 py-2"
                  value={setupForm.endDate}
                  onChange={(event) =>
                    setSetupForm((previous) => ({
                      ...previous,
                      endDate: event.target.value,
                    }))
                  }
                />
              </label>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-medium">Settlement currency</span>
                <input
                  className="rounded-xl border border-slate-300 px-3 py-2 uppercase"
                  value={setupForm.settlementCurrency}
                  maxLength={3}
                  onChange={(event) =>
                    setSetupForm((previous) => ({
                      ...previous,
                      settlementCurrency: event.target.value.toUpperCase(),
                    }))
                  }
                />
              </label>

              <label className="grid gap-2">
                <span className="text-sm font-medium">Default FX rule</span>
                <select
                  className="rounded-xl border border-slate-300 px-3 py-2"
                  value={setupForm.defaultFxRule}
                  onChange={(event) =>
                    setSetupForm((previous) => ({
                      ...previous,
                      defaultFxRule: event.target.value as FxRule,
                    }))
                  }
                >
                  <option value="posted">Actual posted amount</option>
                  <option value="daily_market">Daily market rate</option>
                  <option value="fixed_trip">Fixed trip rate</option>
                </select>
              </label>
            </div>

            {setupForm.defaultFxRule === "fixed_trip" ? (
              <label className="grid gap-2">
                <span className="text-sm font-medium">
                  Fixed trip rate ({setupForm.settlementCurrency || "settlement"} major per original major)
                </span>
                <input
                  className="rounded-xl border border-slate-300 px-3 py-2"
                  type="number"
                  step="0.0001"
                  value={setupForm.fixedTripRate}
                  onChange={(event) =>
                    setSetupForm((previous) => ({
                      ...previous,
                      fixedTripRate: event.target.value,
                    }))
                  }
                />
                <span className="text-xs text-slate-500">
                  Example: 0.0054 means 1.00 original converts to 0.0054 {setupForm.settlementCurrency || "settlement"}.
                </span>
              </label>
            ) : null}

            <label className="grid gap-2">
              <span className="text-sm font-medium">Friend names (comma-separated)</span>
              <textarea
                className="min-h-24 rounded-xl border border-slate-300 px-3 py-2"
                value={setupForm.friendNamesText}
                onChange={(event) =>
                  setSetupForm((previous) => ({
                    ...previous,
                    friendNamesText: event.target.value,
                  }))
                }
              />
            </label>

            {status ? <p className="text-sm text-amber-700">{status}</p> : null}
            {error ? <p className="text-sm text-red-700">{error}</p> : null}

            <button
              className="mt-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              type="submit"
            >
              Create trip
            </button>
            <button
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              type="button"
              onClick={() => {
                actions.seedDemoTrip();
                setStatus("Demo trip loaded with synthetic members and expenses.");
              }}
            >
              Load Demo trip
            </button>
            <p className="text-xs text-slate-500">
              Demo data is fully synthetic and marked for QA only.
            </p>
          </form>
        </section>
      </main>
    );
  }

  const trip = state.trip;

  const activeMemberName = memberName(state.members, state.activeMemberId ?? "");

  return (
    <main className="min-h-screen bg-[#f6f7f5] p-4 text-slate-900 md:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{trip.name}</h1>
              <p className="mt-1 text-sm text-slate-600">
                {trip.startDate} to {trip.endDate} · settlement in {trip.settlementCurrency}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span
                className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800"
              >
                Local mode · saved only on this device
              </span>

              <label className="text-sm">
                <span className="mr-2 text-slate-600">Active member</span>
                <select
                  className="rounded-lg border border-slate-300 px-2 py-1"
                  value={state.activeMemberId ?? ""}
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
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                onClick={() => setShowAdd((previous) => !previous)}
              >
                {showAdd ? "Close add" : "Add"}
              </button>
            </div>
          </div>

          <nav className="mt-5 flex flex-wrap gap-2">
            {([
              ["dashboard", "Dashboard"],
              ["review", "Transaction review"],
              ["expenses", "Expenses"],
              ["settlement", "Settlement"],
              ["settings", "Settings"],
            ] as Array<[AppTab, string]>).map(([value, label]) => (
              <button
                key={value}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  tab === value
                    ? "bg-slate-900 text-white"
                    : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </nav>
        </header>

        {showAdd ? (
          <section className="mt-4 grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-3 md:p-6">
            <article>
              <h2 className="text-lg font-semibold">Manual expense</h2>
              <p className="mt-1 text-sm text-slate-600">One draft expense with split and evidence notes.</p>
              <form
                className="mt-4 grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!manualForm.amount) {
                    return;
                  }

                  try {
                    const amountMinor = parseAmountToMinorUnits(
                      manualForm.amount,
                      trip.settlementCurrency,
                    );
                    const splitConfig = makeSplitConfig({
                      ...manualForm,
                      participantIds: effectiveManualParticipants,
                    }, trip.settlementCurrency);
                    actions.addManualExpense({
                      title: manualForm.title,
                      date: effectiveManualDate,
                      payerId: effectiveManualPayerId,
                      settlementAmountMinor: amountMinor,
                      splitMode: manualForm.splitMode,
                      splitConfig,
                      notes: manualForm.notes,
                    });
                    setStatus("Manual expense added to review queue.");
                  } catch (expenseError) {
                    setStatus(
                      expenseError instanceof Error
                        ? expenseError.message
                        : "Unable to add expense.",
                    );
                  }
                }}
              >
                <input
                  className="rounded-lg border border-slate-300 px-2 py-1.5"
                  placeholder="Description"
                  value={manualForm.title}
                  onChange={(event) =>
                    setManualForm((previous) => ({ ...previous, title: event.target.value }))
                  }
                  required
                />

                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="date"
                    className="rounded-lg border border-slate-300 px-2 py-1.5"
                    value={effectiveManualDate}
                    onChange={(event) =>
                      setManualForm((previous) => ({ ...previous, date: event.target.value }))
                    }
                  />
                  <input
                    className="rounded-lg border border-slate-300 px-2 py-1.5"
                    placeholder={`Amount (${trip.settlementCurrency})`}
                    value={manualForm.amount}
                    onChange={(event) =>
                      setManualForm((previous) => ({ ...previous, amount: event.target.value }))
                    }
                  />
                </div>

                <select
                  className="rounded-lg border border-slate-300 px-2 py-1.5"
                  value={effectiveManualPayerId}
                  onChange={(event) =>
                    setManualForm((previous) => ({ ...previous, payerId: event.target.value }))
                  }
                >
                  {state.members.map((member) => (
                    <option key={member.id} value={member.id}>
                      Paid by {member.name}
                    </option>
                  ))}
                </select>

                <select
                  className="rounded-lg border border-slate-300 px-2 py-1.5"
                  value={manualForm.splitMode}
                  onChange={(event) =>
                    setManualForm((previous) => ({
                      ...previous,
                      splitMode: event.target.value as SplitMode,
                    }))
                  }
                >
                  <option value="equal">Equal</option>
                  <option value="exact">Exact amounts</option>
                  <option value="weighted">Shares/weights</option>
                  <option value="personal">Personal</option>
                </select>

                <fieldset className="grid gap-1 rounded-lg border border-slate-200 p-2">
                  <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Participants
                  </legend>
                  {state.members.map((member) => (
                    <label key={member.id} className="flex items-center justify-between gap-2 text-sm">
                      <span>
                        <input
                          type="checkbox"
                          className="mr-2"
                          disabled={manualForm.splitMode === "personal"}
                          checked={effectiveManualParticipants.includes(member.id)}
                          onChange={(event) => {
                            setManualForm((previous) => {
                              const participantIds =
                                previous.participantIds.length > 0
                                  ? previous.participantIds
                                  : defaultParticipants;
                              const exists = participantIds.includes(member.id);
                              return {
                                ...previous,
                                participantIds: event.target.checked
                                  ? [...participantIds, member.id]
                                  : exists
                                  ? participantIds.filter((id) => id !== member.id)
                                  : participantIds,
                              };
                            });
                          }}
                        />
                        {member.name}
                      </span>

                      {manualForm.splitMode === "exact" ? (
                        <input
                          className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
                          placeholder={trip.settlementCurrency}
                          value={manualForm.exactByMemberId[member.id] ?? "0"}
                          onChange={(event) =>
                            setManualForm((previous) => ({
                              ...previous,
                              exactByMemberId: {
                                ...previous.exactByMemberId,
                                [member.id]: event.target.value,
                              },
                            }))
                          }
                        />
                      ) : null}

                      {manualForm.splitMode === "weighted" ? (
                        <input
                          className="w-20 rounded border border-slate-300 px-2 py-1 text-xs"
                          placeholder="weight"
                          value={manualForm.weightByMemberId[member.id] ?? "1"}
                          onChange={(event) =>
                            setManualForm((previous) => ({
                              ...previous,
                              weightByMemberId: {
                                ...previous.weightByMemberId,
                                [member.id]: event.target.value,
                              },
                            }))
                          }
                        />
                      ) : null}
                    </label>
                  ))}
                </fieldset>

                <textarea
                  className="min-h-20 rounded-lg border border-slate-300 px-2 py-1.5"
                  placeholder="Evidence note"
                  value={manualForm.notes}
                  onChange={(event) =>
                    setManualForm((previous) => ({ ...previous, notes: event.target.value }))
                  }
                />

                <button className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white" type="submit">
                  Add draft
                </button>
              </form>
            </article>

            <article>
              <h2 className="text-lg font-semibold">Statement import</h2>
              <p className="mt-1 text-sm text-slate-600">
                Standard Chartered DDMMYY parser with wrapped-line support.
              </p>

              <label className="mt-4 grid gap-2 text-sm">
                <span>Upload statement files</span>
                <input
                  type="file"
                  multiple
                  onChange={async (event: ChangeEvent<HTMLInputElement>) => {
                    const files = [...(event.target.files ?? [])];
                    for (const file of files) {
                      const validationError = validateUpload(file, "statement");
                      if (validationError) {
                        setStatus(`${file.name}: ${validationError}`);
                        continue;
                      }

                      if (file.type.includes("csv") || file.type.includes("text") || file.name.endsWith(".txt")) {
                        const text = await file.text();
                        const result = actions.importStatementText(text, file.name);
                        setStatus(
                          `${file.name}: ${result.addedCount} rows imported, ${result.duplicateCount} duplicates skipped.`,
                        );
                        continue;
                      }

                      actions.addSourceDraft(
                        file.name,
                        "statement",
                        "Automatic statement extraction is not implemented in this local-only pilot. Paste parsed rows below.",
                      );
                      setStatus(`${file.name}: added as manual review draft.`);
                    }
                  }}
                />
              </label>

              <textarea
                className="mt-3 min-h-40 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs"
                placeholder="Paste Standard Chartered rows, one transaction per line."
                value={statementText}
                onChange={(event) => setStatementText(event.target.value)}
              />

              <button
                className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                onClick={() => {
                  const result = actions.importStatementText(statementText, "pasted-statement");
                  setStatus(
                    `Pasted statement: ${result.addedCount} rows imported, ${result.duplicateCount} duplicates skipped.`,
                  );
                }}
              >
                Import pasted statement
              </button>
            </article>

            <article>
              <h2 className="text-lg font-semibold">Receipt evidence</h2>
              <p className="mt-1 text-sm text-slate-600">
                Local-only pilot: automatic receipt extraction is not implemented. Paste receipt text to parse manually.
              </p>

              <label className="mt-4 grid gap-2 text-sm">
                <span>Upload receipts</span>
                <input
                  type="file"
                  multiple
                  onChange={async (event: ChangeEvent<HTMLInputElement>) => {
                    const files = [...(event.target.files ?? [])];
                    for (const file of files) {
                      const validationError = validateUpload(file, "receipt");
                      if (validationError) {
                        setStatus(`${file.name}: ${validationError}`);
                        continue;
                      }

                      if (
                        file.type.includes("text") ||
                        file.type.includes("json") ||
                        file.name.endsWith(".txt") ||
                        file.name.endsWith(".json")
                      ) {
                        const text = await file.text();
                        actions.addReceiptFromText(text, file.name);
                        setStatus(`${file.name}: receipt text parsed into review queue.`);
                        continue;
                      }

                      actions.addSourceDraft(
                        file.name,
                        "receipt",
                        "Automatic image/PDF extraction is not implemented in this local-only pilot. Paste extracted text below.",
                      );
                      setStatus(`${file.name}: added as receipt draft for manual parse.`);
                    }
                  }}
                />
              </label>

              <textarea
                className="mt-3 min-h-40 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs"
                placeholder="Paste receipt text with merchant, date, currency amount, booking ID, passenger/profile/service if present."
                value={receiptText}
                onChange={(event) => setReceiptText(event.target.value)}
              />
              <button
                className="mt-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                onClick={() => {
                  actions.addReceiptFromText(receiptText, "pasted-receipt");
                  setStatus("Pasted receipt parsed.");
                }}
              >
                Parse pasted receipt
              </button>
            </article>
          </section>
        ) : null}

        {status ? (
          <p className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
            {status}
          </p>
        ) : null}
        {error ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        ) : null}

        {tab === "dashboard" ? (
          <section className="mt-4 grid gap-4 lg:grid-cols-[1.2fr,1fr]">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">Balances</h2>
              <p className="mt-1 text-sm text-slate-600">
                All approved expenses in {trip.settlementCurrency}. Pending and reopened drafts do not affect this ledger.
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Total spend</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {formatMinorUnits(derived.totalSpendMinor, trip.settlementCurrency)}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Pending review</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{derived.pendingExpenses.length}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Approved expenses</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{derived.approvedExpenses.length}</p>
                </div>
              </div>

              <div className="mt-5 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="pb-2">Member</th>
                      <th className="pb-2">Paid</th>
                      <th className="pb-2">Share</th>
                      <th className="pb-2">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {derived.ledgers.map((ledger) => (
                      <tr key={ledger.memberId} className="border-t border-slate-100">
                        <td className="py-2 font-medium">{memberName(state.members, ledger.memberId)}</td>
                        <td className="py-2 tabular-nums">
                          {formatMinorUnits(ledger.paidMinor, trip.settlementCurrency)}
                        </td>
                        <td className="py-2 tabular-nums">
                          {formatMinorUnits(ledger.owedMinor, trip.settlementCurrency)}
                        </td>
                        <td
                          className={`py-2 tabular-nums font-semibold ${
                            ledger.balanceMinor >= 0 ? "text-emerald-700" : "text-amber-700"
                          }`}
                        >
                          {formatMinorUnits(ledger.balanceMinor, trip.settlementCurrency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">Minimum transfer plan</h2>
              <p className="mt-1 text-sm text-slate-600">
                {derived.transferStrategy === "exact"
                  ? "Exact search for 2-10 members. Tie-break keeps stable member order."
                  : "Simplified deterministic fallback used to keep settlement responsive."}
              </p>

              {derived.transfers.length === 0 ? (
                <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  No transfers needed yet.
                </p>
              ) : (
                <ul className="mt-4 grid gap-2 text-sm">
                  {derived.transfers.map((transfer, index) => (
                    <li key={`${transfer.fromMemberId}-${transfer.toMemberId}-${index}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <span className="font-medium">{memberName(state.members, transfer.fromMemberId)}</span>{" "}
                      pays <span className="font-medium">{memberName(state.members, transfer.toMemberId)}</span>{" "}
                      <span className="tabular-nums font-semibold">
                        {formatMinorUnits(transfer.amountMinor, trip.settlementCurrency)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-6 text-xs text-slate-500">
                Active member: {activeMemberName}. Import review is private by uploader.
              </p>
            </div>
          </section>
        ) : null}

        {tab === "review" ? (
          <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Private transaction review</h2>
            <p className="mt-1 text-sm text-slate-600">
              Includes only statement rows inside trip dates. Payments are excluded by default.
            </p>

            {derived.importReviewQueue.length === 0 ? (
              <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                No statement rows imported for this member yet.
              </p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="pb-2">Date</th>
                      <th className="pb-2">Merchant</th>
                      <th className="pb-2">Original</th>
                      <th className="pb-2">Posted</th>
                      <th className="pb-2">Flags</th>
                      <th className="pb-2">State</th>
                      <th className="pb-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {derived.importReviewQueue.map((row) => {
                      const hasExpense = state.expenses.some(
                        (expense) => expense.evidence.statementTransactionId === row.id,
                      );
                      return (
                        <tr key={row.id} className="border-t border-slate-100 align-top">
                          <td className="py-2 tabular-nums">{row.date}</td>
                          <td className="py-2">
                            <p className="font-medium">{row.merchant}</p>
                            <p className="text-xs text-slate-500">{row.reference ?? "no booking ID"}</p>
                          </td>
                          <td className="py-2 tabular-nums">
                            {formatMinorUnits(row.originalAmountMinor, row.originalCurrency)}
                          </td>
                          <td className="py-2 tabular-nums">
                            {row.postedAmountMinor !== null && row.postedCurrency
                              ? formatMinorUnits(row.postedAmountMinor, row.postedCurrency)
                              : "-"}
                          </td>
                          <td className="py-2">
                            <div className="flex flex-wrap gap-1 text-xs">
                              {row.isCredit ? (
                                <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-sky-700">
                                  credit
                                </span>
                              ) : null}
                              {row.isPayment ? (
                                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">
                                  payment
                                </span>
                              ) : null}
                              {row.isFeeOrTax ? (
                                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700">
                                  fee/tax
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="py-2">
                            <select
                              className="rounded border border-slate-300 px-2 py-1 text-xs"
                              value={row.inclusionState}
                              onChange={(event) =>
                                actions.setTransactionInclusion(
                                  row.id,
                                  event.target.value as "included" | "excluded",
                                )
                              }
                              disabled={row.isPayment}
                            >
                              <option value="included">Include</option>
                              <option value="excluded">Exclude</option>
                            </select>
                          </td>
                          <td className="py-2">
                            <button
                              className="rounded border border-slate-300 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                              disabled={row.inclusionState !== "included" || hasExpense || row.isPayment}
                              onClick={() => {
                                actions.createExpenseFromTransaction(row.id, null);
                                setStatus("Draft expense created from statement row.");
                              }}
                            >
                              {hasExpense ? "Draft exists" : "Create draft expense"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <h3 className="mt-6 text-base font-semibold">Receipt match suggestions</h3>
            {derived.suggestedMatches.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">No receipt suggestions yet.</p>
            ) : (
              <ul className="mt-3 grid gap-2 text-sm">
                {derived.suggestedMatches.map(({ receipt, match }) => {
                  const tx = state.statementTransactions.find((row) => row.id === match?.transactionId);
                  if (!match || !tx) {
                    return null;
                  }
                  return (
                    <li key={`${receipt.id}-${tx.id}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="font-medium">
                        {receipt.merchant} → {tx.merchant}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        {match.evidence.join(" • ")}
                      </p>
                      <span className={`mt-2 inline-block rounded-full border px-2 py-0.5 text-xs ${badgeClass(match.confidence)}`}>
                        {match.confidence} confidence · score {match.score}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            <h3 className="mt-6 text-base font-semibold">Source draft queue</h3>
            <p className="mt-1 text-sm text-slate-600">
              After manual review/paste, mark drafts resolved or remove them. Only unresolved drafts block lock.
            </p>
            {state.sourceDrafts.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">No source drafts in queue.</p>
            ) : (
              <ul className="mt-3 grid gap-2 text-sm">
                {state.sourceDrafts.map((draft) => (
                  <li key={draft.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">{draft.name}</p>
                        <p className="text-xs text-slate-600">{draft.kind} · {draft.reason}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {isSourceDraftUnresolved(draft)
                            ? "Status: unresolved"
                            : `Status: resolved${draft.resolvedAt ? ` at ${new Date(draft.resolvedAt).toLocaleString()}` : ""}`}
                        </p>
                      </div>

                      <div className="flex gap-2">
                        {isSourceDraftUnresolved(draft) ? (
                          <button
                            type="button"
                            className="rounded border border-emerald-300 bg-white px-2 py-1 text-xs text-emerald-700"
                            onClick={() => {
                              const resolved = actions.resolveSourceDraft(draft.id);
                              setStatus(
                                resolved
                                  ? `${draft.name}: marked resolved.`
                                  : `${draft.name}: could not mark resolved.`,
                              );
                            }}
                          >
                            Mark resolved
                          </button>
                        ) : null}

                        <button
                          type="button"
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          onClick={() => {
                            const removed = actions.removeSourceDraft(draft.id);
                            setStatus(
                              removed
                                ? `${draft.name}: removed from source draft queue.`
                                : `${draft.name}: could not remove source draft.`,
                            );
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {tab === "expenses" ? (
          <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Expense review</h2>
            <p className="mt-1 text-sm text-slate-600">
              Every row is a draft until approved. Reopened items leave balances immediately.
            </p>

            {state.expenses.length === 0 ? (
              <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                No expense drafts yet.
              </p>
            ) : (
              <div className="mt-4 grid gap-3">
                {state.expenses.map((expense) => {
                  const isEditing = activeExpenseId === expense.id;
                  return (
                    <ExpenseCard
                      key={expense.id}
                      expense={expense}
                      currency={trip.settlementCurrency}
                      members={state.members}
                      comments={state.comments.filter((comment) => comment.expenseId === expense.id)}
                      isEditing={isEditing}
                      reopenDraft={reopenNoteByExpenseId[expense.id] ?? ""}
                      commentDraft={commentDraftByExpenseId[expense.id] ?? ""}
                      onStartEdit={() => setActiveExpenseId(expense.id)}
                      onCancelEdit={() => setActiveExpenseId(null)}
                      onSave={(next) => {
                        actions.updateExpenseDraft(next);
                        setStatus("Expense updated.");
                        setActiveExpenseId(null);
                      }}
                      onApprove={() => {
                        const approved = actions.approveExpense(expense.id);
                        if (approved) {
                          setStatus("Expense approved and added to ledger.");
                        }
                      }}
                      onConfirmPersonal={() => {
                        actions.confirmPersonalClassification(expense.id);
                        setStatus("Personal classification confirmed.");
                      }}
                      onAttachReceipt={(receiptId) => {
                        actions.attachReceiptToExpense(expense.id, receiptId);
                        setStatus("Receipt match confirmed and attached.");
                      }}
                      receipts={state.receipts}
                      onReopenChange={(value) =>
                        setReopenNoteByExpenseId((previous) => ({ ...previous, [expense.id]: value }))
                      }
                      onReopen={() => {
                        const reason = reopenNoteByExpenseId[expense.id] ?? "Need correction";
                        actions.reopenExpense(expense.id, reason);
                        setStatus("Expense reopened and removed from balances.");
                      }}
                      onCommentChange={(value) =>
                        setCommentDraftByExpenseId((previous) => ({ ...previous, [expense.id]: value }))
                      }
                      onCommentAdd={() => {
                        const draft = commentDraftByExpenseId[expense.id] ?? "";
                        actions.addComment(expense.id, draft);
                        setCommentDraftByExpenseId((previous) => ({ ...previous, [expense.id]: "" }));
                      }}
                    />
                  );
                })}
              </div>
            )}
          </section>
        ) : null}

        {tab === "settlement" ? (
          <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Settlement summary</h2>
            <p className="mt-1 text-sm text-slate-600">
              Lock requires all expenses approved, all included statement rows linked, and no unresolved source drafts.
            </p>

            {derived.lockBlockers.pendingExpenses > 0 ||
            derived.lockBlockers.unlinkedIncludedTransactions > 0 ||
            derived.lockBlockers.pendingSourceDrafts > 0 ||
            derived.lockBlockers.unconfirmedPersonalExpenses > 0 ? (
              <ul className="mt-3 grid gap-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                {derived.lockBlockers.pendingExpenses > 0 ? (
                  <li>{derived.lockBlockers.pendingExpenses} expense draft(s) still need approval.</li>
                ) : null}
                {derived.lockBlockers.unlinkedIncludedTransactions > 0 ? (
                  <li>
                    {derived.lockBlockers.unlinkedIncludedTransactions} included statement row(s) are not linked to an expense.
                  </li>
                ) : null}
                {derived.lockBlockers.pendingSourceDrafts > 0 ? (
                  <li>{derived.lockBlockers.pendingSourceDrafts} source document draft(s) are still unresolved.</li>
                ) : null}
                {derived.lockBlockers.unconfirmedPersonalExpenses > 0 ? (
                  <li>
                    {derived.lockBlockers.unconfirmedPersonalExpenses} likely-personal approved expense(s) still need confirmation.
                  </li>
                ) : null}
              </ul>
            ) : null}

            {state.snapshot ? (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
                <p className="font-medium">Ledger locked</p>
                <p className="text-sm">Snapshot created at {new Date(state.snapshot.createdAt).toLocaleString()}.</p>
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
                <p className="font-medium">Ledger open</p>
                <p className="text-sm">Approve all drafts before lock.</p>
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
                disabled={
                  Boolean(state.snapshot) ||
                  derived.lockBlockers.pendingExpenses > 0 ||
                  derived.lockBlockers.unlinkedIncludedTransactions > 0 ||
                  derived.lockBlockers.pendingSourceDrafts > 0 ||
                  derived.lockBlockers.unconfirmedPersonalExpenses > 0
                }
                onClick={() => {
                  const result = actions.lockSnapshot();
                  if (!result.ok) {
                    setStatus(result.reason ?? "Could not lock ledger.");
                    return;
                  }
                  setStatus("Ledger locked. Snapshot saved.");
                }}
              >
                Lock ledger
              </button>

              <button
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                onClick={() =>
                  downloadSettlementCsv(
                    trip.settlementCurrency,
                    state.members,
                    state.snapshot?.memberLedgers ?? derived.ledgers,
                    state.snapshot?.transfers ?? derived.transfers,
                  )
                }
              >
                Export settlement CSV
              </button>
            </div>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-slate-500">
                  <tr>
                    <th className="pb-2">From</th>
                    <th className="pb-2">To</th>
                    <th className="pb-2">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(state.snapshot?.transfers ?? derived.transfers).map((transfer, index) => (
                    <tr key={`${transfer.fromMemberId}-${transfer.toMemberId}-${index}`} className="border-t border-slate-100">
                      <td className="py-2">{memberName(state.members, transfer.fromMemberId)}</td>
                      <td className="py-2">{memberName(state.members, transfer.toMemberId)}</td>
                      <td className="py-2 tabular-nums font-semibold">
                        {formatMinorUnits(transfer.amountMinor, trip.settlementCurrency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {tab === "settings" ? (
          <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Settings and safety</h2>

            <ul className="mt-3 grid gap-2 text-sm text-slate-700">
              <li>
                <span className="font-medium">Storage mode:</span> Local only. Cloud sync is disabled in this build.
              </li>
              <li>
                <span className="font-medium">Sharing:</span> Multi-user sharing is not active in local mode.
              </li>
              <li>
                <span className="font-medium">Upload limits:</span> 8MB max and MIME + extension validation.
              </li>
              <li>
                <span className="font-medium">Model extraction:</span> Not implemented in this local-only pilot. Files require paste/manual parsing.
              </li>
            </ul>

            <h3 className="mt-6 text-base font-semibold">Source draft queue</h3>
            {state.sourceDrafts.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">No pending source drafts.</p>
            ) : (
              <ul className="mt-3 grid gap-2 text-sm">
                {state.sourceDrafts.map((draft) => (
                  <li key={draft.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">{draft.name}</p>
                        <p className="text-xs text-slate-600">{draft.kind} · {draft.reason}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {isSourceDraftUnresolved(draft)
                            ? "Status: unresolved"
                            : `Status: resolved${draft.resolvedAt ? ` at ${new Date(draft.resolvedAt).toLocaleString()}` : ""}`}
                        </p>
                      </div>

                      <div className="flex gap-2">
                        {isSourceDraftUnresolved(draft) ? (
                          <button
                            type="button"
                            className="rounded border border-emerald-300 bg-white px-2 py-1 text-xs text-emerald-700"
                            onClick={() => {
                              const resolved = actions.resolveSourceDraft(draft.id);
                              setStatus(
                                resolved
                                  ? `${draft.name}: marked resolved.`
                                  : `${draft.name}: could not mark resolved.`,
                              );
                            }}
                          >
                            Mark resolved
                          </button>
                        ) : null}

                        <button
                          type="button"
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          onClick={() => {
                            const removed = actions.removeSourceDraft(draft.id);
                            setStatus(
                              removed
                                ? `${draft.name}: removed from source draft queue.`
                                : `${draft.name}: could not remove source draft.`,
                            );
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="mt-6 text-base font-semibold">Audit trail</h3>
            {state.auditEvents.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">No audit events yet.</p>
            ) : (
              <div className="mt-2 max-h-52 overflow-auto rounded-lg border border-slate-200 p-2 text-xs text-slate-600">
                {state.auditEvents.slice(0, 20).map((eventItem) => (
                  <p key={eventItem.id} className="border-b border-slate-100 py-1 last:border-b-0">
                    {eventItem.createdAt} · {eventItem.eventType} · actor {memberName(state.members, eventItem.actorId)}
                  </p>
                ))}
              </div>
            )}

            <button
              className="mt-6 rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700"
              onClick={() => {
                actions.resetAll();
                setStatus("All local state cleared.");
              }}
            >
              Reset local trip data
            </button>
          </section>
        ) : null}
      </div>
    </main>
  );
}

interface ExpenseCardProps {
  expense: Expense;
  currency: string;
  members: Member[];
  comments: Array<{ id: string; memberId: string; body: string; createdAt: string }>;
  receipts: Array<{ id: string; merchant: string; date: string | null }>;
  isEditing: boolean;
  reopenDraft: string;
  commentDraft: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (input: {
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
  }) => void;
  onApprove: () => void;
  onConfirmPersonal: () => void;
  onAttachReceipt: (receiptId: string) => void;
  onReopenChange: (value: string) => void;
  onReopen: () => void;
  onCommentChange: (value: string) => void;
  onCommentAdd: () => void;
}

function ExpenseCard({
  expense,
  currency,
  members,
  comments,
  receipts,
  isEditing,
  reopenDraft,
  commentDraft,
  onStartEdit,
  onCancelEdit,
  onSave,
  onApprove,
  onConfirmPersonal,
  onAttachReceipt,
  onReopenChange,
  onReopen,
  onCommentChange,
  onCommentAdd,
}: ExpenseCardProps) {
  const scale = getCurrencyScale(currency);
  const [title, setTitle] = useState(expense.title);
  const [date, setDate] = useState(expense.date);
  const [payerId, setPayerId] = useState(expense.payerId);
  const [amount, setAmount] = useState((expense.settlementAmountMinor / 10 ** scale).toFixed(scale));
  const [splitMode, setSplitMode] = useState<SplitMode>(expense.splitMode);
  const [participantIds, setParticipantIds] = useState(expense.splitConfig.participantIds);
  const [notes, setNotes] = useState(expense.notes);
  const [fxRule, setFxRule] = useState<FxRule>(expense.fxRule);
  const [fxRate, setFxRate] = useState(expense.fxRate?.toString() ?? "");
  const [exactAmounts, setExactAmounts] = useState<Record<string, string>>(
    Object.fromEntries(
      members.map((member) => [
        member.id,
        fromMinorUnits(expense.splitConfig.exactAmountByMemberId?.[member.id] ?? 0, currency).toFixed(scale),
      ]),
    ),
  );
  const [weights, setWeights] = useState<Record<string, string>>(
    Object.fromEntries(
      members.map((member) => [
        member.id,
        (expense.splitConfig.weightByMemberId?.[member.id] ?? 1).toString(),
      ]),
    ),
  );
  const needsPersonalConfirmation =
    expense.likelyPersonal.likely && !expense.personalClassificationConfirmed;
  const sourceAmountLabel =
    expense.originalCurrency && expense.originalAmountMinor !== null
      ? `${formatMinorUnits(expense.originalAmountMinor, expense.originalCurrency)} source`
      : null;

  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">{expense.title}</h3>
          <p className="mt-1 text-xs text-slate-600">
            {expense.date} · paid by {memberName(members, expense.payerId)} · {expense.status}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Settlement amount in {currency}
            {sourceAmountLabel ? ` · ${sourceAmountLabel}` : ""}
          </p>
        </div>

        <div className="text-right">
          <p className="tabular-nums text-lg font-semibold">{formatMinorUnits(expense.settlementAmountMinor, currency)}</p>
          <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${badgeClass(expense.likelyPersonal.confidence)}`}>
            {expense.likelyPersonal.likely ? "Likely personal" : "Shared/uncertain"}
          </span>
        </div>
      </div>

      {expense.likelyPersonal.reasons.length > 0 ? (
        <p className="mt-2 text-xs text-slate-600">Evidence: {expense.likelyPersonal.reasons.join(" • ")}</p>
      ) : null}

      {needsPersonalConfirmation ? (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-semibold">Likely personal expense requires confirmation.</p>
          <p className="mt-1">
            This draft defaults to payer-only personal split. Confirm it as personal, or deliberately change the split to shared before approval.
          </p>
          {expense.splitMode === "personal" ? (
            <button
              className="mt-2 rounded border border-amber-400 bg-white px-2 py-1 text-xs font-medium text-amber-900"
              onClick={onConfirmPersonal}
            >
              Confirm personal classification
            </button>
          ) : null}
        </div>
      ) : null}

      {expense.receiptMatch ? (
        <div className="mt-2 rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-600">
          <p className="font-medium text-slate-700">Receipt match evidence</p>
          <p>{expense.receiptMatch.evidence.join(" • ")}</p>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {!isEditing ? (
          <button className="rounded border border-slate-300 px-2 py-1 text-xs" onClick={onStartEdit}>
            Edit draft
          </button>
        ) : (
          <button className="rounded border border-slate-300 px-2 py-1 text-xs" onClick={onCancelEdit}>
            Close edit
          </button>
        )}

        {expense.status !== "approved" ? (
          <button
            className="rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-40"
            onClick={onApprove}
            disabled={needsPersonalConfirmation && expense.splitMode === "personal"}
          >
            Approve
          </button>
        ) : null}
      </div>

      {isEditing ? (
        <form
          className="mt-4 grid gap-2 rounded-lg border border-slate-200 bg-white p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const splitConfig: SplitConfig =
              splitMode === "exact"
                ? {
                    participantIds,
                    exactAmountByMemberId: Object.fromEntries(
                      participantIds.map((memberId) => [
                        memberId,
                        parseAmountToMinorUnits(exactAmounts[memberId] ?? "0", currency),
                      ]),
                    ),
                  }
                : splitMode === "weighted"
                ? {
                    participantIds,
                    weightByMemberId: Object.fromEntries(
                      participantIds.map((memberId) => [
                        memberId,
                        Number.parseInt(weights[memberId] ?? "1", 10) || 1,
                      ]),
                    ),
                  }
                : { participantIds };

            onSave({
              expenseId: expense.id,
              title,
              date,
              payerId,
              settlementAmountMinor: parseAmountToMinorUnits(amount, currency),
              splitMode,
              splitConfig,
              notes,
              fxRule,
              fxRate: fxRate ? Number.parseFloat(fxRate) : null,
            });
          }}
        >
          <input className="rounded border border-slate-300 px-2 py-1.5 text-sm" value={title} onChange={(event) => setTitle(event.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <input type="date" className="rounded border border-slate-300 px-2 py-1.5 text-sm" value={date} onChange={(event) => setDate(event.target.value)} />
            <input
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              value={amount}
              placeholder={`Settlement amount (${currency})`}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>

          <select className="rounded border border-slate-300 px-2 py-1.5 text-sm" value={payerId} onChange={(event) => setPayerId(event.target.value)}>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>

          <div className="grid grid-cols-2 gap-2">
            <select className="rounded border border-slate-300 px-2 py-1.5 text-sm" value={fxRule} onChange={(event) => setFxRule(event.target.value as FxRule)}>
              <option value="posted">posted amount</option>
              <option value="daily_market">daily market</option>
              <option value="fixed_trip">fixed rate</option>
            </select>
            <input
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="FX rate (settlement per original)"
              value={fxRate}
              onChange={(event) => setFxRate(event.target.value)}
            />
          </div>
          <p className="text-xs text-slate-500">
            If FX rule or rate changes, settlement amount recomputes from original or posted source amounts when available.
          </p>

          <select className="rounded border border-slate-300 px-2 py-1.5 text-sm" value={splitMode} onChange={(event) => setSplitMode(event.target.value as SplitMode)}>
            <option value="equal">Equal</option>
            <option value="exact">Exact</option>
            <option value="weighted">Weighted</option>
            <option value="personal">Personal</option>
          </select>

          <fieldset className="rounded border border-slate-200 p-2 text-sm">
            <legend className="px-1 text-xs uppercase tracking-wide text-slate-600">Participants</legend>
            {members.map((member) => (
              <label key={member.id} className="mb-1 flex items-center justify-between gap-2">
                <span>
                  <input
                    type="checkbox"
                    className="mr-2"
                    checked={participantIds.includes(member.id)}
                    disabled={splitMode === "personal"}
                    onChange={(event) => {
                      setParticipantIds((previous) =>
                        event.target.checked
                          ? [...previous, member.id]
                          : previous.filter((id) => id !== member.id),
                      );
                    }}
                  />
                  {member.name}
                </span>

                {splitMode === "exact" ? (
                  <input
                    className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
                    placeholder={currency}
                    value={exactAmounts[member.id] ?? "0"}
                    onChange={(event) =>
                      setExactAmounts((previous) => ({
                        ...previous,
                        [member.id]: event.target.value,
                      }))
                    }
                  />
                ) : null}

                {splitMode === "weighted" ? (
                  <input
                    className="w-20 rounded border border-slate-300 px-2 py-1 text-xs"
                    value={weights[member.id] ?? "1"}
                    onChange={(event) =>
                      setWeights((previous) => ({
                        ...previous,
                        [member.id]: event.target.value,
                      }))
                    }
                  />
                ) : null}
              </label>
            ))}
          </fieldset>

          <textarea
            className="min-h-20 rounded border border-slate-300 px-2 py-1.5 text-sm"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />

          <button className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white" type="submit">
            Save edits
          </button>
        </form>
      ) : null}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-slate-600">
          <span>Attach confirmed receipt</span>
          <select className="rounded border border-slate-300 px-2 py-1" onChange={(event) => event.target.value && onAttachReceipt(event.target.value)} defaultValue="">
            <option value="" disabled>
              Select receipt
            </option>
            {receipts.map((receipt) => (
              <option key={receipt.id} value={receipt.id}>
                {receipt.merchant} ({receipt.date ?? "no date"})
              </option>
            ))}
          </select>
        </label>

        {expense.status === "approved" ? (
          <div className="grid gap-1 text-xs text-slate-600">
            <span>Reopen with reason</span>
            <div className="flex gap-2">
              <input
                className="w-full rounded border border-slate-300 px-2 py-1"
                value={reopenDraft}
                onChange={(event) => onReopenChange(event.target.value)}
              />
              <button className="rounded border border-slate-300 px-2 py-1" onClick={onReopen}>
                Reopen
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-3 rounded-lg border border-slate-200 bg-white p-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Comments</p>
        {comments.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">No comments yet.</p>
        ) : (
          <ul className="mt-2 grid gap-1 text-xs text-slate-600">
            {comments.slice(0, 6).map((comment) => (
              <li key={comment.id} className="rounded border border-slate-100 bg-slate-50 p-2">
                <p className="font-medium">{memberName(members, comment.memberId)}</p>
                <p>{comment.body}</p>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-2 flex gap-2">
          <input
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs"
            value={commentDraft}
            onChange={(event) => onCommentChange(event.target.value)}
            placeholder="Add comment"
          />
          <button className="rounded border border-slate-300 px-2 py-1 text-xs" onClick={onCommentAdd}>
            Add
          </button>
        </div>
      </div>
    </article>
  );
}
