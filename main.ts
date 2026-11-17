// BTC race bot: deep dip-buy mean-reversion, one full-size position at a time.
//
// Idea (validated on the published dev window): 1-minute cbBTC is choppy noise
// (6 bps/min) with rare deep dips that snap back. Shallow dips, trailing stops
// and scale-ins all lose to the ~35 bps round-trip cost, so this bot only buys
// a dip of 1.50% or more off the trailing 120-minute high, only while the
// 4-hour trend is not down more than 1%, and only after 240 bars of history.
// It sells the whole position at +0.80% from its fill, at -1.00%, or after
// 240 bars, then rests 30 bars. In a window so quiet no dip ever comes, a
// fallback ladder relaxes the dip late in the window so the entry still makes
// its minimum one trade. All comparisons are exact BigInt math, no floats,
// no clock, no randomness: two runs on the same bars answer identically.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

/** Dip off the trailing 120-minute high that counts as a signal, in bps. */
const DIP_BPS = 150;
/** Bars in the trailing-high window. */
const HIGH_BARS = 120;
/** Bars in the trend filter window (4 hours). */
const FILTER_BARS = 240;
/** The 4-hour return must be at or above this, in bps (-100 = -1.00%). */
const FILTER_MIN_BPS = -100;
/** Sell when the close is this far above the fill, in bps. */
const TARGET_BPS = 80;
/** Sell when the close is this far below the fill, in bps. */
const STOP_BPS = 100;
/** Sell after holding this many bars. */
const MAX_HOLD_BARS = 240;
/** No entry before this scored bar: the filter needs 240 bars of history. */
const WARMUP_BARS = 240;
/** Bars to rest after an exit before a new entry. */
const COOLDOWN_BARS = 30;
/** Slippage cap left wide open; it never bound on the dev window. */
const MAX_SLIPPAGE_BPS = 10000;
/** Fallback ladder, only while no dip signal ever fired and nothing traded. */
const FALLBACK_1_BAR = 1080;
const FALLBACK_1_DIP_BPS = 75;
const FALLBACK_2_BAR = 1260;
const FALLBACK_2_DIP_BPS = 50;
const FALLBACK_3_BAR = 1320;

/** Closes of the scored bars, by scored index; null where a bar was missing. */
const closes: (bigint | null)[] = [];
/** Fill price of the open position, in price units; null while flat. */
let entryPx: bigint | null = null;
/** Scored bar the open position filled on. */
let entryBar = -1;
/** Scored bar of the last exit decision. */
let lastExitBar = -1_000_000_000;
/** Whether a 150 bps dip signal ever fired on an eligible bar. */
let everSignal = false;
/** Whether an exit was ever decided. */
let traded = false;

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const symbol = state.hello.symbols[0]!.symbol;
    // Scored index: warm-up batches (if any) sit before the scored window.
    const i = batch.seq - state.warmupBars;
    if (state.warmingUp || i < 0) return [];
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];
    const c = BigInt(bar.c);
    closes[i] = c;

    // Learn the open position's fill price from this batch's fills.
    for (const fill of batch.fills) {
      if (fill.symbol === symbol && fill.side === 'buy' && fill.status === 'filled') {
        entryPx = BigInt(fill.price);
        entryBar = i;
      }
    }

    const pos = state.positions.get(symbol);
    if (pos !== undefined && pos.qty > 0n) {
      if (entryPx === null) {
        // Safety net only: derive the average entry price from the position's
        // cost (fees included). Fills always arrive, so this never fires.
        const s = state.hello.symbols[0]!;
        entryPx = (pos.cost * 10n ** BigInt(s.qty_scale + s.price_scale)) /
          (pos.qty * 10n ** BigInt(state.hello.capital.quote_scale));
        entryBar = i;
      }
      const target = c * 10000n >= entryPx * BigInt(10000 + TARGET_BPS);
      const stop = c * 10000n <= entryPx * BigInt(10000 - STOP_BPS);
      const timedOut = i - entryBar >= MAX_HOLD_BARS;
      if (target || stop || timedOut) {
        lastExitBar = i;
        traded = true;
        return [{ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: no entry before the warm-up, and rest after an exit.
    if (i < WARMUP_BARS || i - lastExitBar < COOLDOWN_BARS) return [];

    // Trailing 120-minute high, current close included.
    let hi = 0n;
    for (let j = i - HIGH_BARS + 1; j <= i; j++) {
      const v = j >= 0 ? closes[j] : null;
      if (v !== null && v !== undefined && v > hi) hi = v;
    }
    if (hi === 0n) return [];

    const signal150 = c * 10000n <= hi * BigInt(10000 - DIP_BPS);
    if (signal150) everSignal = true;

    // Fallback ladder: only while no dip signal ever fired and nothing traded.
    let dip = DIP_BPS;
    let useFilter = true;
    if (!everSignal && !traded) {
      if (i >= FALLBACK_3_BAR) {
        return [{ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      if (i >= FALLBACK_2_BAR) {
        dip = FALLBACK_2_DIP_BPS;
        useFilter = false;
      } else if (i >= FALLBACK_1_BAR) {
        dip = FALLBACK_1_DIP_BPS;
        useFilter = false;
      }
    }

    if (c * 10000n > hi * BigInt(10000 - dip)) return [];
    if (useFilter) {
      const ref = i - FILTER_BARS >= 0 ? closes[i - FILTER_BARS] : null;
      if (ref === null || ref === undefined) return [];
      if (c * 10000n < ref * BigInt(10000 + FILTER_MIN_BPS)) return [];
    }
    if (state.cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
