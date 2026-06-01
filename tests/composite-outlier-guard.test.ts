/**
 * Regression test for the outlier guard's two stacked corrections in applyGuards:
 *
 *   1. peg-normalization (commit 73f9d29 / "Bug #2") — judge USDT venues in USD
 *      space so USD-native venues aren't cut when USDT is off-peg.
 *   2. premium-offset correction (this change) — judge the leave-one-out-corrected
 *      normalized close, so a USD-native venue's STRUCTURAL cross-exchange premium
 *      (bitfinex — no peg, identity under normalization) isn't rejected before
 *      buildComposite's correction, which exists to absorb exactly that premium,
 *      ever runs.
 *
 * Run:  npx tsx --test tests/composite-outlier-guard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyGuards } from "../src/lib/composite.js";
import type { SourceResult } from "../src/types/index.js";

const SIGMA = 26.2;
const flat = (c: number) => ({ open: c, high: c, low: c, close: c, volume: 1 });
const byName = (g: ReturnType<typeof applyGuards>) => Object.fromEntries(g.map((x) => [x.source, x]));

// Three venues cluster ~68319; bitfinex (USD-native) carries a real ~+$30 USD
// basis. No pegRates → normalization is identity, isolating the premium layer.
const RESULTS: SourceResult[] = [
  { source: "coinbase", candle: flat(68318) },
  { source: "kraken",   candle: flat(68319) },
  { source: "binance",  candle: flat(68321) },
  { source: "bitfinex", candle: flat(68349) },
];

describe("outlier guard — peg-normalized + premium-corrected", () => {
  it("keeps a USD-native structurally-premiumed venue (premium correction on)", () => {
    // Corrected bitfinex ≈ 68325 sits ~$4.5 from the corrected median, inside σ.
    const g = byName(applyGuards(RESULTS, 3, SIGMA, undefined, /*premiumEnabled*/ true));
    assert.equal(g.bitfinex.rejected, false, "bitfinex should survive");
    for (const s of ["coinbase", "kraken", "binance"]) assert.equal(g[s].rejected, false);
  });

  it("preserves the peg-normalized-only behavior when premiumEnabled=false", () => {
    // Falls back to the plain normalized close: median([..])=68320, |68349-68320|
    // =29 > σ=26.2 → bitfinex rejected, exactly as before this change.
    const g = byName(applyGuards(RESULTS, 3, SIGMA, undefined, /*premiumEnabled*/ false));
    assert.equal(g.bitfinex.rejected, true);
    assert.equal(g.bitfinex.rejectedReason, "outlier");
  });

  it("still rejects gross noise with correction on (the guard's real job)", () => {
    const withFatFinger: SourceResult[] = [...RESULTS, { source: "okx", candle: flat(680000) }];
    const g = byName(applyGuards(withFatFinger, 3, SIGMA, undefined, true));
    assert.equal(g.okx.rejected, true, "10x fat-finger must be rejected");
    assert.equal(g.okx.rejectedReason, "outlier");
    assert.equal(g.bitfinex.rejected, false, "premium venue still survives next to noise");
  });

  it("peg normalization still applies under the corrected guard", () => {
    // binance (USDT) raw 68360 would be a +$40 outlier; its peg rate 0.9994
    // normalizes it to ~68319 so it agrees with the USD-native cluster.
    const pegged: SourceResult[] = [
      { source: "coinbase", candle: flat(68318) },
      { source: "kraken",   candle: flat(68319) },
      { source: "bitfinex", candle: flat(68320) },
      { source: "binance",  candle: flat(68360) }, // USDT-quoted
    ];
    const pegRates = new Map<string, number>([["binance", 0.9994]]);
    const g = byName(applyGuards(pegged, 3, SIGMA, pegRates, true));
    assert.equal(g.binance.rejected, false, "peg-normalized binance should survive");
    // Sanity: without the peg rate it WOULD be cut as a raw outlier.
    const gRaw = byName(applyGuards(pegged, 3, SIGMA, undefined, false));
    assert.equal(gRaw.binance.rejected, true, "unnormalized binance is a raw outlier");
  });
});
