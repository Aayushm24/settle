# Settle MVP

Settle is a local-first AI reconciliation workbench for group trips. You drop statements and receipts, Settle extracts and classifies them, then you review one transaction at a time until the settlement is complete.

Data is saved in `localStorage` only. There is no cloud sync or multi-user backend in this build.

## Product flow

- Setup starts with a minimal prompt: creator, trip name, dates, settlement currency, friend names, and one universal file drop zone.
- Upload is unified. Statement and receipt files go through one queue with per-file status: `queued`, `reading`, `extracted`, `imported`, `receipt_added`, `needs_help`, `failed`.
- Classification is deterministic from extracted structure first:
  - many `DDMMYY` rows -> statement
  - date-prefixed non-pilot rows (`DD/MM/YYYY` or `YYYY-MM-DD`) -> possible statement (manual recovery)
  - totals/booking/passenger/order style evidence -> receipt
  - user can override per file when confidence is low
- Statement importer in this pilot currently supports Standard Chartered layouts. Other layouts are surfaced as possible statement and require recovery cleanup before import.
- Extraction stays real:
  - PDF text extraction with pdf.js
  - local OCR for images and scanned PDF pages with Tesseract.js
  - recovery drawer appears only when extraction/import needs help
- Review loop is sequential and explicit. Every transaction must end as excluded/payment or linked to an approved expense.
- Focused transaction card includes merchant, date, amounts, payer, split, confidence, and evidence.
- Command bar is deterministic client logic (no fake AI call):
  - `this was only me` / `only me` / `personal`
  - `shared by everyone` / `split between everyone` / `all of us`
  - `split between X, Y`
  - `X paid` / `X paid this in cash`
  - `attach receipt X` / `match this to receipt X`
  - `exclude this` / `include this`
- Draft settlement updates live with reviewed count, unresolved amount, balances, and minimum transfers.

## Security and privacy

- Local-only storage. No public env var auto-sync path.
- File validation enforces size and allowed extension/MIME combinations.
- Parsed data remains draft until explicit per-transaction review.
- Source and financial details are not shared externally by default.
- OCR worker and language assets are fetched by Tesseract.js at runtime; extracted content remains in-browser.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Verification

```bash
npm test
npm run lint
npm run build
npm audit --audit-level=high
```

Vitest covers statement parsing, receipt matching, split math, ledger transfer planning, file classification, review progress, and command parsing.

## Sharing status

- Current status: single-device local mode only.
- Share action copies a plain-text draft settlement, not a live collaboration link.

## Architecture notes

See `docs/architecture.md` for module-level design and data flow.
