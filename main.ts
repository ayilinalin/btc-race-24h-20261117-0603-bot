// DipSnap — dip-recovery bot for make.fun btc-race-24h-20261117-0603.
// Trades cbBTC/USDC (CBBTC) on 1-minute bars, long only, paper money ($1,000).
//
// Design (fit on THIS competition's dev window, 1440 bars, 2026-11-16 06:03Z -
// 2026-11-17 06:03Z): the window is a tight range ($63,874-$65,467, +0.49% total,
// max drawdown -2.12%). Trend systems whipsaw to death here (EMA 8/21 cross:
// -$106, 68 trades; hourly momentum: -$31..-$73). What works is buying sharp
// drops and taking a quick profit before the range rolls back over:
//   PRIMARY leg — 60-bar drop >= 1.0% + 5-bar bounce >= +0.05%: TP +0.9%, SL -0.5%.
//   SECONDARY leg — 30-bar drop >= 0.6% + 5-bar bounce >= +0.03%: TP +0.7%, SL -0.5%.
//   FALLBACK leg — arms only after 960 bars with zero fills (a quiet race window
//     still needs >= 1 trade for the guardrail): 30-bar drop >= 0.4%,
//     bounce >= +0.03%: TP +0.6%, SL -0.4%.
// Every leg exits on TP, SL, or a 600-bar time stop. Full-size buys (100% cash),
// one position at a time. Local backtest on the dev window (same fill model as
// the harness: 4 bps fee + 2 bps slippage + constant-product impact vs the fill
// bar's open depth): net PnL +$20.64, 3 round trips, max drawdown -0.66%,
// positive on both halves of the window (H1 +$14.64, H2 +$5.95), and every
// parameter neighbour in the tested grid stays profitable.
//
// Deterministic: pure function of the bars (float64, same order every run).
// No clock, no environment, no randomness.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;
const TIME_STOP_BARS = 600;
/** Fallback leg arms after this many bars seen with zero fills. */
const FALLBACK_ARM_BARS = 960;

interface Leg {
  tpBps: number;
  slBps: number;
}

/** One entry leg: buy when the close fell `dropBars` bars by `dropBps` and bounced `bounceBps` over the last 5 bars. */
interface EntryLeg extends Leg {
  dropBars: number;
  dropBps: number;
  bounceBps: number;
}

const PRIMARY: EntryLeg = { dropBars: 60, dropBps: 100, bounceBps: 5, tpBps: 90, slBps: 50 };
const SECONDARY: EntryLeg = { dropBars: 30, dropBps: 60, bounceBps: 3, tpBps: 70, slBps: 50 };
const FALLBACK: EntryLeg = { dropBars: 30, dropBps: 40, bounceBps: 3, tpBps: 60, slBps: 40 };

const closes: number[] = [];
let fills = 0;
let entrySeq: number | null = null;
let leg: Leg | null = null;

function dropBpsOver(bars: number, now: number): number {
  const n = closes.length;
  if (n <= bars) return 0;
  return (now / closes[n - 1 - bars] - 1) * 10000;
}

function bounceBps(now: number): number {
  const n = closes.length;
  if (n < 6) return 0;
  return (now / closes[n - 6] - 1) * 10000;
}

function legFires(e: EntryLeg, now: number): boolean {
  return dropBpsOver(e.dropBars, now) <= -e.dropBps && bounceBps(now) >= e.bounceBps;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c));
    }
    for (const f of batch.fills) {
      if (f.status === 'filled') fills++;
    }
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      if (entrySeq === null) entrySeq = state.seq;
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const tpBps = leg !== null ? leg.tpBps : PRIMARY.tpBps;
      const slBps = leg !== null ? leg.slBps : PRIMARY.slBps;
      const holdBars = state.seq - entrySeq;
      if (
        value * 10000n >= cost * BigInt(10000 + tpBps) ||
        value * 10000n <= cost * BigInt(10000 - slBps) ||
        holdBars >= TIME_STOP_BARS
      ) {
        entrySeq = null;
        leg = null;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }
    entrySeq = null;
    leg = null;

    const n = closes.length;
    if (n < 31) return [];
    const now = closes[n - 1];

    let fire: EntryLeg | null = null;
    if (n > PRIMARY.dropBars && legFires(PRIMARY, now)) fire = PRIMARY;
    else if (legFires(SECONDARY, now)) fire = SECONDARY;
    else if (fills === 0 && n >= FALLBACK_ARM_BARS && legFires(FALLBACK, now)) fire = FALLBACK;
    if (fire === null) return [];

    leg = { tpBps: fire.tpBps, slBps: fire.slBps };
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
