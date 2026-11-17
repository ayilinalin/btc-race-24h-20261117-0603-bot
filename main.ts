// DipSnap v2 — BTC trading bot for btc-race-24h-20261117-0603.
// Two legs sharing one position slot (long only, full-size, 1 open position):
//   LEG A — dip-recovery (kept from v1 DipSnap, proven on the dev window):
//     primary:   60-bar drop >= 1.0% from the 60-bar high close + 5-bar bounce >= +0.05%
//                -> TP +1.0%, SL -0.5%
//     secondary: 30-bar drop >= 0.6% + 5-bar bounce >= +0.03% -> TP +0.8%, SL -0.5%
//     fallback:  after bar 960 with zero fills, 30-bar drop >= 0.4% -> TP +0.6%, SL -0.4%
//     all dip exits: TP / SL / time-stop 600 bars.
//   LEG B — trend ride (new in v2: v1 had nothing for a trending race window):
//     enter when the market is unambiguously trending up: EMA(8)-EMA(21) gap >= 30 bps
//     AND 60-bar return >= +0.8% AND close above EMA(8). Exit on a 0.6% trailing stop
//     from the peak close, EMA cross-down, SL -0.6% from entry, or time-stop 720 bars.
//     No fixed take-profit: a real trend is ridden, not capped.
// TP/SL are measured against the buy's FILL price (read back from the batch's fills).
// Deterministic: pure functions of the closes; no clock, no randomness, no environment.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

// Dip leg parameters (validated on the dev window; grid neighbours all stay profitable).
const DIP_DROP_60 = 0.01;
const DIP_BOUNCE_5_PRIMARY = 0.0005;
const DIP_TP_PRIMARY = 0.01;
const DIP_DROP_30 = 0.006;
const DIP_BOUNCE_5_SECONDARY = 0.0003;
const DIP_TP_SECONDARY = 0.008;
const DIP_SL = -0.005;
const DIP_TS_BARS = 600;
const FALLBACK_BAR = 960;
const FALLBACK_DROP_30 = 0.004;
const FALLBACK_TP = 0.006;
const FALLBACK_SL = -0.004;

// Trend leg parameters (fires only in a genuine uptrend; on the chop dev window it
// fires once and costs ~$3-6 of whipsaw — the price of trend exposure in the race).
const TREND_GAP_MIN_BPS = 30;
const TREND_RET_60_MIN = 0.008;
const TREND_TRAIL = 0.006;
const TREND_SL = -0.006;
const TREND_TS_BARS = 720;

type Leg = 'primary' | 'secondary' | 'fallback' | 'trend';

interface Entry {
  leg: Leg;
  /** Fill price of the buy, USDC per cbBTC (float). */
  entryPrice: number;
  /** Batch seq of the bar the buy filled on. */
  entrySeq: number;
  /** Highest close since entry (trend trailing stop). */
  peak: number;
}

/** EMA in float64, seeded as the mean of its first span of closes (kit baseline style). */
class Ema {
  readonly span: number;
  private warm: number[] = [];
  value: number | null = null;
  constructor(span: number) {
    this.span = span;
  }
  push(x: number): void {
    if (this.value !== null) {
      this.value += (2 / (this.span + 1)) * (x - this.value);
      return;
    }
    this.warm.push(x);
    if (this.warm.length === this.span) this.value = this.warm.reduce((a, b) => a + b, 0) / this.span;
  }
}

const closes: number[] = [];
const emaFast = new Ema(8);
const emaSlow = new Ema(21);
let prevGapBps: number | null = null;
let entry: Entry | null = null;
let myFills = 0;
let orderNo = 0;
/** client_id -> leg of the buy it belongs to (so the fill can be matched back). */
const pendingBuys = new Map<string, Leg>();

function closeAt(back: number): number | null {
  // closes[closes.length - 1] is the current bar's close; back=1 is the bar before it.
  const idx = closes.length - 1 - back;
  return idx >= 0 ? closes[idx]! : null;
}

function maxClose(window: number): number | null {
  // Max close of the `window` bars BEFORE the current bar (current bar excluded).
  const start = Math.max(0, closes.length - 1 - window);
  const end = closes.length - 1;
  if (end <= start) return null;
  let m = -Infinity;
  for (let i = start; i < end; i++) if (closes[i]! > m) m = closes[i]!;
  return m;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c) / 1e5;
    closes.push(close);
    emaFast.push(close);
    emaSlow.push(close);
    const gapBps = emaFast.value !== null && emaSlow.value !== null
      ? ((emaFast.value - emaSlow.value) / emaSlow.value) * 10000
      : null;

    // Sync entry state from this batch's fills (buys fill at this bar's open).
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.client_id.startsWith('_')) continue;
      if (fill.side === 'buy' && pendingBuys.has(fill.client_id)) {
        const leg = pendingBuys.get(fill.client_id)!;
        pendingBuys.delete(fill.client_id);
        const price = Number(fill.price) / 1e5;
        entry = { leg, entryPrice: price, entrySeq: state.seq, peak: price };
        myFills++;
      } else if (fill.side === 'sell') {
        entry = null;
        myFills++;
      }
    }
    for (const id of [...pendingBuys.keys()]) {
      const rejected = batch.fills.some((f) => f.client_id === id && f.status === 'rejected');
      if (rejected) pendingBuys.delete(id);
    }

    if (state.warmingUp) {
      prevGapBps = gapBps;
      return [];
    }

    const orders: (BuyInput | SellInput)[] = [];
    const held = state.positions.get(SYMBOL);

    if (entry !== null && held !== undefined) {
      // ---- exits ----
      const ret = close / entry.entryPrice - 1;
      if (close > entry.peak) entry.peak = close;
      const isTrend = entry.leg === 'trend';
      const tp = isTrend ? Infinity : entry.leg === 'primary' ? DIP_TP_PRIMARY : entry.leg === 'secondary' ? DIP_TP_SECONDARY : FALLBACK_TP;
      const sl = isTrend ? TREND_SL : entry.leg === 'fallback' ? FALLBACK_SL : DIP_SL;
      const ts = isTrend ? TREND_TS_BARS : DIP_TS_BARS;
      const trailHit = isTrend && (entry.peak - close) / entry.peak >= TREND_TRAIL;
      const crossDown = isTrend && gapBps !== null && prevGapBps !== null && gapBps < 0 && prevGapBps >= 0;
      if (ret >= tp || ret <= sl || state.seq - entry.entrySeq >= ts || trailHit || crossDown) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      prevGapBps = gapBps;
      return orders;
    }

    // ---- entries (flat) ----
    const hi60 = maxClose(60);
    const hi30 = maxClose(30);
    const c5 = closeAt(5);
    const c60 = closeAt(60);
    const bounce5 = c5 !== null ? close / c5 - 1 : -1;
    let leg: Leg | null = null;
    if (hi60 !== null && (hi60 - close) / hi60 >= DIP_DROP_60 && bounce5 >= DIP_BOUNCE_5_PRIMARY) {
      leg = 'primary';
    } else if (hi30 !== null && (hi30 - close) / hi30 >= DIP_DROP_30 && bounce5 >= DIP_BOUNCE_5_SECONDARY) {
      leg = 'secondary';
    } else if (state.seq >= FALLBACK_BAR && myFills === 0 && hi30 !== null && (hi30 - close) / hi30 >= FALLBACK_DROP_30) {
      leg = 'fallback';
    } else if (
      gapBps !== null && gapBps >= TREND_GAP_MIN_BPS &&
      c60 !== null && close / c60 - 1 >= TREND_RET_60_MIN &&
      emaFast.value !== null && close > emaFast.value
    ) {
      leg = 'trend';
    }

    if (leg !== null) {
      let notional = state.cash;
      const room = state.weightRoom(SYMBOL);
      if (room < notional) notional = room;
      if (notional >= BigInt(state.hello.fees.min_notional_quote_units) && notional > 0n) {
        const id = `b${++orderNo}`;
        pendingBuys.set(id, leg);
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id });
      }
    }
    prevGapBps = gapBps;
    return orders;
  },
});
