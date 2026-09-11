# Settle MVP Architecture

## Runtime model

- App shell: Next.js App Router with one local-first reconciliation workbench at `src/app/page.tsx`.
- Persistence adapter: `localStorage` (`src/lib/local-repository.ts`) so the app works immediately with no credentials.
- Security posture:
  - No cloud persistence adapter in client code.
  - No auto-enable sync from environment variables.
  - Multi-user sharing is intentionally not active in local mode.
  - PDF text extraction runs via `pdfjs-dist/legacy` with explicit cleanup and a `Promise.withResolvers` fallback for older Safari.
  - OCR runs in-browser via Tesseract.js (worker/language assets fetched at runtime).
  - File uploads are size-limited and require allowed MIME plus matching extension, except extension-only fallback when browsers provide empty MIME.

## Core data flow

1. Setup captures creator, members, trip dates, and settlement currency, with one universal file drop zone.
2. Upload queue processes files sequentially and classifies extracted text as `statement`, `receipt`, or `unknown`.
3. Statement import runs Standard Chartered parsing with DDMMYY support and trip-date inclusive filtering.
4. Receipt parsing extracts merchant/date/amount/booking/passenger metadata for reconciliation evidence.
5. Every statement transaction enters explicit review: payment/excluded rows are resolved, included rows must be approved or excluded.
6. Focused transaction review supports deterministic command parsing and a structured inline edit drawer.
7. Ledger and settlement calculations run on approved expenses only.
8. Snapshot locking is allowed only when unresolved blockers are zero.

## Local-only sharing status

- This build is single-device local mode only.
- Secure multi-user sharing requires a server-backed repository with identity, trip-level authorization, and default-deny access policies.

## Deterministic logic modules

- Money and precision: `src/lib/money.ts`.
- Date parsing and inclusive ranges: `src/lib/date.ts`.
- Statement parsing: `src/lib/statement-parser.ts`.
- File classification and command parsing: `src/lib/file-classification.ts`, `src/lib/command-parser.ts`.
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
- File classification and review-progress counting.
- Deterministic transaction command parsing.
- Split rounding and exact constraints.
- Ledger zero-sum and minimum-transfer output.
