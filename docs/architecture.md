# Settle MVP Architecture

## Runtime model

- App shell: Next.js App Router with one local-first client application at `src/app/page.tsx`.
- Persistence adapter: `localStorage` (`src/lib/local-repository.ts`) so the app works immediately with no credentials.
- Security posture:
  - No cloud persistence adapter in client code.
  - No auto-enable sync from environment variables.
  - Multi-user sharing is intentionally not active in local mode.
  - No model extraction implementation in this local-only pilot; uploaded files require manual paste/parsing.
  - File uploads are size-limited and require allowed MIME plus matching extension, except extension-only fallback when browsers provide empty MIME.

## Core data flow

1. Trip setup captures creator, members, trip dates, settlement currency, and default FX rule.
2. Statement import runs Standard Chartered parsing with DDMMYY support and trip-date inclusive filtering.
3. Imported rows enter private review with include/exclude state. Payment rows are auto-excluded.
4. Receipts are parsed from text/paste and held as review evidence.
5. Expense drafts are created manually or from statement rows.
6. Reviewers confirm split mode and allocations before approval.
7. Ledger and settlement calculations run on approved expenses only.
8. Snapshot locking stores the final transfer plan, and any ledger-affecting change invalidates it.

## Local-only sharing status

- This build is single-device local mode only.
- Secure multi-user sharing requires a server-backed repository with identity, trip-level authorization, and default-deny access policies.

## Deterministic logic modules

- Money and precision: `src/lib/money.ts`.
- Date parsing and inclusive ranges: `src/lib/date.ts`.
- Statement parsing: `src/lib/statement-parser.ts`.
- Likely-personal flagging: `src/lib/personal-flag.ts`.
- Receipt matching evidence: `src/lib/receipt-matching.ts`.
- Split math and rounding: `src/lib/splits.ts`.
- Ledger and minimum-transfer search: `src/lib/ledger.ts`.

## Testing focus

Vitest tests cover:

- Standard Chartered parsing behavior.
- Inclusive date filtering.
- Likely-personal evidence logic.
- Receipt-match scoring.
- Split rounding and exact constraints.
- Ledger zero-sum and minimum-transfer output.
