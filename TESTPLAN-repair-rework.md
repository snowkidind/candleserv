# candleserv-repair-rework — Acceptance Test Plan

Local writable instance (`candleserv` DB on localhost, backend `:3007`, frontend Vite `:5180`).

## Process rules
- **BTC = destructive sandbox.** Recompose / overwrite / repair freely; full 7-venue/90d, re-syncable from the remote (`synchronizeWithRemoteDb.ts`) if corrupted.
- **TON = frozen deficiency fixture.** 6h gap (`09:17–14:56`), 2-venue-ish live, a timeline breakpoint at `2026-06-03 12:35 → +gate`. **Never recompose/overwrite TON** — it's the known-bad state for gap / low-confidence / live-vs-timeline-divergence tests.
- Test against HEAD (backend restarted; frontend HMR'd).
- Log failures, batch frontend fixes after the pass, then re-verify failures.

## Backend / logic (verified server-side) — ALL PASS
- [x] **S0** per-venue config + probed candle/peg depths (kraken 12h, gate ~6d, bybit shallow peg)
- [x] **S2** batched inserts + coverage-skip / resume (covered tile → no fetch, `tilesSkipped`)
- [x] **S3** per-minute formula timeline: straddle a breakpoint → each segment its as-of venues
- [x] **S3** live auto-ban (Redis) does NOT alter history / does not block repair
- [x] **S4** repair fetch set = timeline (not getActiveFeeds), ignores overlay
- [x] **S4** per-currency lock: one currency's repair doesn't 503 another's reads; `suspendGlobal` 503s all
- [x] **S5** per-venue tile/throttle/timeout from config + candle & peg depth pre-flight (skip/flag, no blind 400s)
- [x] **S6** existing-minute overwrite: OFF preserves (coverage-skip), ON re-fetches + DO UPDATE
- [x] **S7** per-currency source retention, stables snap-to-oldest, orphan-safe prune (0 orphans)
- [x] **X** compose-math invariance: recompose twice = byte-identical
- [x] **no-future**: repair window into the current minute is rejected
- [x] **fail-loud**: write errors log + rethrow (no silent fallback) — build-verified

## UI (operator) — ALL PASS (2026-06-03/04 round)
- [x] **#1** Feeds = LIVE feeds only + Max-depth column (kraken 12h; TON `—`)
- [x] **#2** Repair Range disclosure on Feeds tab; scoped to the currency sub-tab (no dropdown)
- [x] **#3** Repair feed selection → "Save as timeline version" writes a dated `currency_formula_versions` row (+ `formula.version.set` audit)
- [x] **#4** Existing-minute toggles; stable toggle reveals/hides "Suspend REST globally"
- [x] **#5** Recompose-only (BTC 17:00→17:18): job audited `steps:["recompose"]`, 21 composites rewritten, no fetch
- [x] **#6** Per-venue tuning & depth table (read-only)
- [x] **#7** Source retention auto-save (200→null, both audited, survives refresh)
- [x] **#8** Min sources auto-save (3→null, both audited, survives refresh)
- [x] **#9** Admin → Maintenance: healer panel gone; prune-pause toggled on/off, both audited
- [x] **#10** InfoTips across Feeds/Repair/Admin; console clean (no nested-button warning)

**RESULT: full acceptance pass — backend 12/12, UI 10/10. Zero failures.**

## Follow-up fixes (applied this session)
- [x] Auto-save for Feeds number fields (controlled + debounced; no lost edits)
- [x] Nested-button hydration fix on Re-probe / Recompose-only / Cancel
- [x] Dev proxy → `:3007`
- [x] prune orphan guard; dead exchange-config override dropped; phase→step comments
- [x] `.env.remote-ro` gitignored
- [ ] Max-depth column (added; kept as bonus/roadmap item #4 — not part of original scope)

## Known / deferred
- Sync re-render bug: not reproducing after the FeedsTab rework — "watch for recurrence."
- Backfill-depth-vs-retention coupling: deferred until plan reviewed (your call).
- Cosmetic: Repair panel's tuning table floors kraken's candle depth to `0` days (real: 720m/12h; the Feeds Max-depth column formats it correctly) — fix is a one-line formatter swap.
