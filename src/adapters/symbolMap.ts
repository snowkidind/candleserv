/**
 * Per-(currency, source) venue symbol map. Multi-currency Phase 1.9 seeds
 * currency_sources from this constant; Phase 2 parameterizes the adapters to
 * fetch by symbol instead of the old hardcoded literals.
 *
 * BTC rows are ground-truth — they match the symbol literals currently
 * hardcoded in each adapter (binance.ts BTCUSDT, kraken.ts XBTUSD,
 * coinbase.ts BTC-USD, etc.). Do NOT change a BTC symbol without changing the
 * corresponding adapter; the BTC byte-compat gate (D3) depends on it.
 *
 * Major-asset symbols follow each venue's pattern (USDT venues: <COIN>USDT /
 * <COIN>-USDT / <COIN>_USDT; USD-native venues: <COIN>USD / <COIN>-USD /
 * t<COIN>USD). Entries marked `⚠ verify` are best-guess; the Phase-2
 * availability probe (scripts/probeAvailability.ts) is the source of truth and
 * will set currency_sources.available=false for any pair a venue doesn't list,
 * so a wrong guess fails safe rather than spamming fetch errors.
 */
export type SourceName =
  | "binance" | "bybit" | "kraken" | "coinbase"
  | "bitfinex" | "okx" | "gate" | "bitget";

export const SYMBOL_MAP: Record<string, Partial<Record<SourceName, string>>> = {
  // Ground truth — mirrors the hardcoded literals in each adapter.
  BTC: {
    binance:  "BTCUSDT",
    bybit:    "BTCUSDT",
    kraken:   "XBTUSD",
    coinbase: "BTC-USD",
    bitfinex: "tBTCUSD",
    okx:      "BTC-USDT",
    gate:     "BTC_USDT",
    bitget:   "BTCUSDT",
  },
  ETH: {
    binance:  "ETHUSDT",
    bybit:    "ETHUSDT",
    kraken:   "ETHUSD",   // ⚠ verify — Kraken may key the response as XETHZUSD
    coinbase: "ETH-USD",
    bitfinex: "tETHUSD",
    okx:      "ETH-USDT",
    gate:     "ETH_USDT",
    bitget:   "ETHUSDT",
  },
  SOL: {
    binance:  "SOLUSDT",
    bybit:    "SOLUSDT",
    kraken:   "SOLUSD",
    coinbase: "SOL-USD",
    bitfinex: "tSOLUSD",
    okx:      "SOL-USDT",
    gate:     "SOL_USDT",
    bitget:   "SOLUSDT",
  },
  TRX: {
    binance:  "TRXUSDT",
    bybit:    "TRXUSDT",
    kraken:   "TRXUSD",    // ⚠ verify
    coinbase: "TRX-USD",   // ⚠ verify — Coinbase likely does not list TRX-USD
    bitfinex: "tTRXUSD",   // ⚠ verify
    okx:      "TRX-USDT",
    gate:     "TRX_USDT",
    bitget:   "TRXUSDT",
  },
  // TON → GRAM rebrand: same asset, code renamed. gate/bitget have rebranded
  // (their TON symbols are delisted), so they fetch the live GRAM symbol; the
  // other six venues keep their current live TON symbol until each rebrands,
  // at which point its symbol flips to its GRAM form (Stage 5 rolling repoint).
  GRAM: {
    binance:  "TONUSDT",   // flips to GRAM form once binance rebrands (Stage 5)
    bybit:    "TONUSDT",   // flips to GRAM form once bybit rebrands (Stage 5)
    kraken:   "TONUSD",    // flips to GRAM form once kraken rebrands (Stage 5)
    coinbase: "TON-USD",   // flips to GRAM form once coinbase rebrands (Stage 5)
    bitfinex: "tTONUSD",   // flips to GRAM form once bitfinex rebrands (Stage 5)
    okx:      "TON-USDT",  // flips to GRAM form once okx rebrands (Stage 5)
    gate:     "GRAM_USDT", // rebranded — TON symbol delisted
    bitget:   "GRAMUSDT",  // rebranded — TON symbol delisted
  },
  BNB: {
    binance:  "BNBUSDT",
    bybit:    "BNBUSDT",
    kraken:   "BNBUSD",    // ⚠ verify — little/none
    coinbase: "BNB-USD",   // ⚠ verify — none expected
    bitfinex: "tBNBUSD",   // ⚠ verify — none expected
    okx:      "BNB-USDT",
    gate:     "BNB_USDT",
    bitget:   "BNBUSDT",
  },
};

export const SUPPORTED_CURRENCIES = Object.keys(SYMBOL_MAP);

/**
 * Venue symbol for a (currency, source). Throws if unmapped — a fetch issued for
 * an unmapped pair is a wiring bug, and silent fallbacks are banned in this
 * codebase. The live fetch set is gated upstream by currency_sources, so this
 * should only ever be called for mapped pairs.
 */
export function symbolFor(currency: string, source: string): string {
  const sym = SYMBOL_MAP[currency]?.[source as SourceName];
  if (!sym) throw new Error(`[symbolMap] no symbol mapped for ${currency}/${source}`);
  return sym;
}
