// BTC race bot: shallow SMA90 dip-buy with drawdown-tapered size, one position
// at a time (round 3 — replaces the deep dip-buy baseline, dev +$12.17).
//
// Idea (validated on the published dev window, grade-local +$42.55, 6 trades,
// DD 0.72%): 1-minute cbBTC snaps back from shallow dips, but a dip bought
// while the day is already falling is a loss — so the bot only buys when the
// close is 0.80% under its 90-bar average AND the 4-hour return is not down
// more than 1%, and it sizes by how far the day has fallen from its open
// (100% / 70% / 40% / 20%). It exits at +2.00% when the day drifted down
// more than 30 bps at entry, +0.70% when the day is near its open, at -1.00%,
// or after 420 bars (extended to 480 while a +2.00% target is running hot).
// A $5 loss cap stops new entries, then it rests 30 bars. In a window so
// quiet no dip ever comes, a fallback ladder relaxes the dip late in the
// window so the entry still makes its minimum one trade; the fallback runs
// whenever nothing has traded, even if a signal fired but was filtered.
// All comparisons are exact BigInt math, no floats, no clock, no randomness:
// two runs on the same bars answer identically.
//
// Built from the round-2 rebuild (Codex analysis + Claude prototypes):
// the old bots' edge was fit to one 24h window and reversed on down days
// (and45v3 +$8.46 dev, -$5.85 race, -$66.11 next window). This spec's two
// structural changes are a 420-bar hold (episode 2 only reaches +2.00% at
// bar 961, 387 bars after entry) and size tapering on down days; out-of-sample
// on four real down days totals -$8.16 (worst window -$2.32), vs -$42.01 for
// the C hybrid and -$25.19 for the baseline. Dev profit still comes mostly
// from two rebound episodes — if the race day falls all day, expect ~$0,
// not a big loss.
import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SMA_BARS = 90;
const SMA_DIP_BPS = 80;
const FILTER_BARS = 240;
const FILTER_MIN_BPS = -100;
const LOSS_CAP_QUOTE = 5_000_000n;
const TARGET_BPS = 200;
const CALM_TARGET_BPS = 70;
const DRIFT_SPLIT_BPS = 30;
const STOP_BPS = 100;
const MAX_HOLD_BARS = 420;
const EXTEND_HOLD_BARS = 480;
const WARMUP_BARS = 240;
const COOLDOWN_BARS = 30;
const MAX_SLIPPAGE_BPS = 10000;
const FALLBACK_1_BAR = 1080, FALLBACK_1_DIP_BPS = 75;
const FALLBACK_2_BAR = 1260, FALLBACK_2_DIP_BPS = 50;
const FALLBACK_3_BAR = 1320;
/** size % by session drawdown from the first scored close, in bps. */
const TAPER: [number, number][] = [[80, 100], [110, 70], [150, 40], [99999, 20]];

const closes: (bigint | null)[] = [];
let entryPx: bigint | null = null;
let entryBar = -1;
let targetBps = TARGET_BPS;
let pendingTarget: number | null = null;
let lastExitBar = -1_000_000_000;
let traded = false;

function sizePct(driftBps: number): number {
  for (const [limit, pct] of TAPER) if (driftBps <= limit) return pct;
  return 20;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const symbol = state.hello.symbols[0]!.symbol;
    const i = batch.seq - state.warmupBars;
    if (state.warmingUp || i < 0) return [];
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];
    const c = BigInt(bar.c);
    closes[i] = c;

    for (const fill of batch.fills) {
      if (fill.symbol === symbol && fill.side === 'buy' && fill.status === 'filled') {
        entryPx = BigInt(fill.price);
        entryBar = i;
        if (pendingTarget !== null) { targetBps = pendingTarget; pendingTarget = null; }
      }
    }

    const pos = state.positions.get(symbol);
    if (pos !== undefined && pos.qty > 0n) {
      if (entryPx === null) { entryPx = c; entryBar = i; }
      const target = c * 10000n >= entryPx * BigInt(10000 + targetBps);
      const stop = c * 10000n <= entryPx * BigInt(10000 - STOP_BPS);
      const extended = targetBps === TARGET_BPS && c * 10000n >= entryPx * 10040n &&
        c >= closes[i - 30]! && i - entryBar < EXTEND_HOLD_BARS;
      const timedOut = i - entryBar >= MAX_HOLD_BARS && !extended;
      if (target || stop || timedOut) {
        lastExitBar = i;
        traded = true;
        return [{ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (i < WARMUP_BARS || i - lastExitBar < COOLDOWN_BARS) return [];
    if (state.equity < BigInt(state.hello.capital.quote_units) - LOSS_CAP_QUOTE) return [];

    let sum = 0n;
    for (let j = i - SMA_BARS + 1; j <= i; j++) sum += closes[j]!;
    const smaSignal = c * BigInt(SMA_BARS) * 10000n <= sum * BigInt(10000 - SMA_DIP_BPS);
    const filter = c * 10000n >= closes[i - FILTER_BARS]! * BigInt(10000 + FILTER_MIN_BPS);

    let buy = smaSignal && filter;
    let fallbackBuy = false;
    if (!buy && !traded) {
      let hi = 0n;
      for (let j = i - 119; j <= i; j++) { const v = closes[j]; if (v !== null && v !== undefined && v > hi) hi = v; }
      if (i >= FALLBACK_3_BAR) buy = filter;
      else if (i >= FALLBACK_2_BAR) buy = c * 10000n <= hi * BigInt(10000 - FALLBACK_2_DIP_BPS);
      else if (i >= FALLBACK_1_BAR) buy = c * 10000n <= hi * BigInt(10000 - FALLBACK_1_DIP_BPS);
      fallbackBuy = buy;
    }
    if (!buy) return [];
    if (fallbackBuy) {
      const d0 = closes[0]!;
      pendingTarget = Number((d0 - c) * 10000n / d0) > DRIFT_SPLIT_BPS ? TARGET_BPS : CALM_TARGET_BPS;
      return [{ side: 'buy', symbol, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    const day0 = closes[0];
    if (day0 === null || day0 === undefined) return [];
    const drift = Number((day0 - c) * 10000n / day0);
    const spend = state.cash * BigInt(sizePct(drift)) / 100n;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    pendingTarget = drift > DRIFT_SPLIT_BPS ? TARGET_BPS : CALM_TARGET_BPS;
    return [{ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
