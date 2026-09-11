"use client";

import { useMemo, useState } from "react";

import {
  fromMinorUnits,
  getCurrencyScale,
} from "@/lib/money";
import {
  ExpenseEditorFieldErrors,
  validateExpenseEditorInput,
} from "@/lib/expense-editor-validation";
import {
  Expense,
  FxRule,
  Member,
  ReceiptEvidence,
  SplitConfig,
  SplitMode,
} from "@/lib/types";

export interface ExpenseEditorProps {
  expense: Expense;
  currency: string;
  members: Member[];
  receipts: ReceiptEvidence[];
  onAttachReceipt: (receiptId: string) => void;
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
}

export function ExpenseEditor({
  expense,
  currency,
  members,
  receipts,
  onAttachReceipt,
  onSave,
}: ExpenseEditorProps) {
  const scale = getCurrencyScale(currency);

  const [title, setTitle] = useState(expense.title);
  const [date, setDate] = useState(expense.date);
  const [payerId, setPayerId] = useState(expense.payerId);
  const [amount, setAmount] = useState(fromMinorUnits(expense.settlementAmountMinor, currency).toFixed(scale));
  const [splitMode, setSplitMode] = useState<SplitMode>(expense.splitMode);
  const [participantIds, setParticipantIds] = useState<string[]>(expense.splitConfig.participantIds);
  const [notes, setNotes] = useState(expense.notes);
  const [fxRule, setFxRule] = useState<FxRule>(expense.fxRule);
  const [fxRate, setFxRate] = useState(expense.fxRate?.toString() ?? "");
  const [exactByMemberId, setExactByMemberId] = useState<Record<string, string>>(
    Object.fromEntries(
      members.map((member) => [
        member.id,
        fromMinorUnits(expense.splitConfig.exactAmountByMemberId?.[member.id] ?? 0, currency).toFixed(scale),
      ]),
    ),
  );
  const [weightByMemberId, setWeightByMemberId] = useState<Record<string, string>>(
    Object.fromEntries(
      members.map((member) => [member.id, (expense.splitConfig.weightByMemberId?.[member.id] ?? 1).toString()]),
    ),
  );
  const [fieldErrors, setFieldErrors] = useState<ExpenseEditorFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const canAttemptSave = useMemo(() => {
    if (!title.trim() || !date.trim() || !amount.trim()) {
      return false;
    }
    if (!payerId) {
      return false;
    }
    if (splitMode === "personal") {
      return participantIds.length === 1 && participantIds[0] === payerId;
    }
    return participantIds.length > 0;
  }, [amount, date, participantIds, payerId, splitMode, title]);

  return (
    <form
      className="grid gap-2 text-sm"
      onSubmit={(event) => {
        event.preventDefault();

        const validation = validateExpenseEditorInput({
          expenseId: expense.id,
          currency,
          memberIds: members.map((member) => member.id),
          title,
          date,
          payerId,
          amountText: amount,
          splitMode,
          participantIds,
          exactByMemberId,
          weightByMemberId,
          notes,
          fxRule,
          fxRateText: fxRate,
        });

        if (!validation.ok) {
          setFieldErrors(validation.errors);
          setFormError(null);
          return;
        }

        try {
          onSave(validation.value);
          setFieldErrors({});
          setFormError(null);
        } catch (submitError) {
          setFormError(submitError instanceof Error ? submitError.message : "Could not save expense edits.");
        }
      }}
    >
      <label className="grid gap-1">
        <span className="text-xs text-zinc-600">Title</span>
        <input
          className="h-11 rounded-xl border border-zinc-300 bg-white px-3"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setFieldErrors((previous) => ({ ...previous, title: undefined }));
          }}
        />
      </label>
      {fieldErrors.title ? <p className="text-xs text-red-600">{fieldErrors.title}</p> : null}

      <div className="grid gap-2 md:grid-cols-2">
        <label className="grid gap-1">
          <span className="text-xs text-zinc-600">Date</span>
          <input
            type="date"
            className="h-11 rounded-xl border border-zinc-300 bg-white px-3"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setFieldErrors((previous) => ({ ...previous, date: undefined }));
            }}
          />
        </label>

        <label className="grid gap-1">
          <span className="text-xs text-zinc-600">Settlement amount ({currency})</span>
          <input
            className="h-11 rounded-xl border border-zinc-300 bg-white px-3"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setFieldErrors((previous) => ({ ...previous, amount: undefined }));
            }}
          />
        </label>
      </div>
      {fieldErrors.date ? <p className="text-xs text-red-600">{fieldErrors.date}</p> : null}
      {fieldErrors.amount ? <p className="text-xs text-red-600">{fieldErrors.amount}</p> : null}

      <div className="grid gap-2 md:grid-cols-2">
        <label className="grid gap-1">
          <span className="text-xs text-zinc-600">Payer</span>
          <select
            className="h-11 rounded-xl border border-zinc-300 bg-white px-3"
            value={payerId}
            onChange={(event) => {
              const nextPayerId = event.target.value;
              setPayerId(nextPayerId);
              setFieldErrors((previous) => ({ ...previous, payerId: undefined, participants: undefined }));
              if (splitMode === "personal") {
                setParticipantIds([nextPayerId]);
              }
            }}
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1">
          <span className="text-xs text-zinc-600">Split mode</span>
          <select
            className="h-11 rounded-xl border border-zinc-300 bg-white px-3"
            value={splitMode}
            onChange={(event) => {
              const nextMode = event.target.value as SplitMode;
              setSplitMode(nextMode);
              setFieldErrors((previous) => ({ ...previous, participants: undefined, split: undefined }));
              if (nextMode === "personal") {
                setParticipantIds([payerId]);
              }
            }}
          >
            <option value="equal">Equal</option>
            <option value="exact">Exact</option>
            <option value="weighted">Weighted</option>
            <option value="personal">Personal</option>
          </select>
        </label>
      </div>

      <fieldset className="rounded-xl border border-zinc-300 bg-white p-3">
        <legend className="px-1 text-xs uppercase tracking-[0.1em] text-zinc-600">Participants</legend>
        <div className="grid gap-2">
          {members.map((member) => (
            <label key={member.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                <input
                  type="checkbox"
                  className="mr-2"
                  checked={participantIds.includes(member.id)}
                  disabled={splitMode === "personal"}
                  onChange={(event) => {
                    setParticipantIds((previous) => {
                      if (event.target.checked) {
                        return previous.includes(member.id) ? previous : [...previous, member.id];
                      }
                      return previous.filter((id) => id !== member.id);
                    });
                    setFieldErrors((previous) => ({ ...previous, participants: undefined, split: undefined }));
                  }}
                />
                {member.name}
              </span>

              {splitMode === "exact" ? (
                <input
                  className="h-9 w-24 rounded-lg border border-zinc-300 px-2 text-xs"
                  value={exactByMemberId[member.id] ?? "0"}
                    onChange={(event) =>
                      {
                        setExactByMemberId((previous) => ({ ...previous, [member.id]: event.target.value }));
                        setFieldErrors((previous) => ({ ...previous, split: undefined }));
                      }
                    }
                  />
              ) : null}

              {splitMode === "weighted" ? (
                <input
                  className="h-9 w-20 rounded-lg border border-zinc-300 px-2 text-xs"
                  value={weightByMemberId[member.id] ?? "1"}
                    onChange={(event) =>
                      {
                        setWeightByMemberId((previous) => ({ ...previous, [member.id]: event.target.value }));
                        setFieldErrors((previous) => ({ ...previous, split: undefined }));
                      }
                    }
                  />
              ) : null}
            </label>
          ))}
        </div>
      </fieldset>
      {fieldErrors.payerId ? <p className="text-xs text-red-600">{fieldErrors.payerId}</p> : null}
      {fieldErrors.participants ? <p className="text-xs text-red-600">{fieldErrors.participants}</p> : null}
      {fieldErrors.split ? <p className="text-xs text-red-600">{fieldErrors.split}</p> : null}

      <div className="grid gap-2 md:grid-cols-2">
        <label className="grid gap-1">
          <span className="text-xs text-zinc-600">FX rule</span>
          <select
            className="h-11 rounded-xl border border-zinc-300 bg-white px-3"
            value={fxRule}
            onChange={(event) => {
              setFxRule(event.target.value as FxRule);
              setFieldErrors((previous) => ({ ...previous, fxRate: undefined }));
            }}
          >
            <option value="posted">Posted</option>
            <option value="daily_market">Daily market</option>
            <option value="fixed_trip">Fixed trip rate</option>
          </select>
        </label>

        <label className="grid gap-1">
          <span className="text-xs text-zinc-600">FX rate</span>
          <input
            className="h-11 rounded-xl border border-zinc-300 bg-white px-3"
            value={fxRate}
            onChange={(event) => {
              setFxRate(event.target.value);
              setFieldErrors((previous) => ({ ...previous, fxRate: undefined }));
            }}
            placeholder="Optional"
          />
        </label>
      </div>
      {fieldErrors.fxRate ? <p className="text-xs text-red-600">{fieldErrors.fxRate}</p> : null}

      <label className="grid gap-1">
        <span className="text-xs text-zinc-600">Notes</span>
        <textarea
          className="min-h-24 rounded-xl border border-zinc-300 bg-white px-3 py-2"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>

      <label className="grid gap-1">
        <span className="text-xs text-zinc-600">Attach receipt</span>
        <select
          className="h-11 rounded-xl border border-zinc-300 bg-white px-3"
          defaultValue=""
          onChange={(event) => {
            if (event.target.value) {
              onAttachReceipt(event.target.value);
            }
          }}
        >
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

      {formError ? <p className="text-xs text-red-600">{formError}</p> : null}

      <button
        type="submit"
        disabled={!canAttemptSave}
        className="min-h-11 rounded-2xl bg-black px-4 text-sm font-medium text-white disabled:opacity-40"
      >
        Save edits
      </button>
    </form>
  );
}
