# Settle MVP

Settle is a local-first trip settlement app that turns statement rows and receipts into a reviewable group ledger and an exact minimum-transfer plan.

The app runs in explicit local-only mode using `localStorage`. Multi-user cloud sharing is not active in this build.

## What is implemented

- Trip setup at root route (no landing page).
- Fixed default pilot window: `2026-08-23` through `2026-09-02` (editable).
- Main product flow tabs:
  - Dashboard
  - Transaction review
  - Expenses
  - Settlement
  - Settings
- Add action supports:
  - Manual expense entry
  - Statement CSV/text import
  - Receipt upload/pasted text
- Standard Chartered parser supports:
  - DDMMYY dates
  - Wrapped merchant descriptions
  - Original + INR posted amounts
  - `CR` credits as negative values
  - Forex Markup Fee / CGST / SGST rows as reviewable fee/tax items
  - Payment-row exclusion (`SCB Ibanking Payment`)
- Split modes:
  - Equal
  - Exact amounts
  - Shares/weights
  - Personal
  - Mixed handled through exact allocations
- Deterministic ledger logic:
  - Integer minor-unit math only
  - Zero-sum member balances
  - Exact minimum-transfer search for 2-10 members, bounded with a deterministic simplified fallback for oversized legacy data
- Likely-personal and receipt-match evidence surfaced as explainable suggestions.
- Lock snapshot with auto-invalidation on ledger-affecting changes.
- CSV export with formula-safe sanitization.
- Privacy-safe demo seed to test a full trip flow without real data.

## Security and privacy notes

- Local mode does not read public env vars for cloud sync.
- Multi-user sharing is disabled in local mode.
- File upload validation enforces allowed MIME type plus matching allowed extension (or extension-only fallback when browser MIME is empty) and 8 MB limits.
- Automatic PDF/image model extraction is not implemented in this local-only pilot; files require paste/manual parsing.
- Parsed data is always reviewable draft data until approved.
- Audit events store redacted change summaries, not raw statement text or full source payloads.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment contract

Copy `.env.example` to `.env.local`.

- Local mode: no variables are required.

Never commit real secret values.

## Deploy

- Vercel or any Next.js host:
  - Build command: `npm run build`
  - Start command: `npm start`
- Local-only deployment: no cloud persistence variables required.

## Tests and verification

```bash
npm test
npm run lint
npm run build
```

Vitest covers parsing, date inclusivity, likely-personal logic, receipt matching, split rounding, ledger zero-sum, and minimum transfers.

## Multi-user sharing status

- Current status: disabled. This app persists to browser-local storage only.
- To safely enable secure sharing later, add a server-backed persistence layer with per-user identity, per-trip authorization, RLS default-deny policies, encrypted storage paths for uploads, and server-side audit redaction controls.

## Architecture notes

See `docs/architecture.md` for module-level design and data flow.
