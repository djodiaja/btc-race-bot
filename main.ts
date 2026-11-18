// Momentum Reversal with Confirmation
//
// Core insight: in a bearish market, don't enter at the bottom of a dip.
// Enter AFTER the bounce is confirmed by positive short-term momentum.
//
// Entry conditions (all must be true):
//   - 20-bar momentum < -0.4% (there was a significant dip)
//   - 5-bar momentum > 0.08% (bounce is underway, confirmed)
//   - EMA(3) > EMA(8) (micro trend turned up)
//
// Exit conditions (any one):
//   - Value >= cost * 1.010 (take profit 1.0%)
//   - Value <= cost * 0.995 (stop loss 0.5%)
//   - 5-bar momentum < -0.05% and held for > 10 bars (momentum dying)
//   - Held for 150 bars (time stop, 2.5 hours)
//
// Deterministic, float64 only, no randomness.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const MOM_SHORT = 5;
const MOM_LONG = 20;
const EMA_FAST = 3;
const EMA_SLOW = 8;

const MOM_LONG_ENTRY_BELOW = -0.004;   // 20-bar momentum < -0.4% (deeper dip required)
const MOM_SHORT_ENTRY_ABOVE = 0.0008;  // 5-bar momentum > 0.08% (confirmed bounce)
const MOM_SHORT_EXIT_BELOW = -0.0005;  // 5-bar momentum dying

const TP_NUM = 1010n;   // 1.0% take profit
const TP_DEN = 1000n;
const SL_NUM = 995n;    // 0.5% stop loss
const SL_DEN = 1000n;
const TIME_STOP = 150;  // 2.5 hours
const MIN_HOLD = 10;    // minimum hold before momentum exit

const MAX_SLIPPAGE_BPS = 60;

interface EmaState {
  span: number;
  warm: number[];
  value: number | null;
}

interface SymbolState {
  closes: number[];        // last MOM_LONG + 1 closes
  emaFast: EmaState;
  emaSlow: EmaState;
  entryBar: number;
}

const symbols = new Map<string, SymbolState>();

function newEma(span: number): EmaState {
  return { span, warm: [], value: null };
}

function stepEma(e: EmaState, c: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (c - e.value);
  } else {
    e.warm.push(c);
    if (e.warm.length === e.span) {
      e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
    }
  }
}

function getOrCreate(symbol: string): SymbolState {
  let s = symbols.get(symbol);
  if (!s) {
    s = {
      closes: [],
      emaFast: newEma(EMA_FAST),
      emaSlow: newEma(EMA_SLOW),
      entryBar: -999,
    };
    symbols.set(symbol, s);
  }
  return s;
}

function update(bar: Bar): void {
  const s = getOrCreate(bar.symbol);
  const c = Number(bar.c);
  s.closes.push(c);
  if (s.closes.length > MOM_LONG + 1) s.closes.shift();
  stepEma(s.emaFast, c);
  stepEma(s.emaSlow, c);
}

function momN(s: SymbolState, n: number): number | null {
  if (s.closes.length < n + 1) return null;
  const prev = s.closes[s.closes.length - 1 - n]!;
  const curr = s.closes[s.closes.length - 1]!;
  if (prev === 0) return null;
  return (curr - prev) / prev;
}

function shouldEnter(s: SymbolState): boolean {
  const momLong = momN(s, MOM_LONG);
  const momShort = momN(s, MOM_SHORT);
  if (momLong === null || momShort === null) return false;

  // There was a dip AND bounce is confirmed
  if (momLong >= MOM_LONG_ENTRY_BELOW) return false;
  if (momShort <= MOM_SHORT_ENTRY_ABOVE) return false;

  // Micro trend must be up
  if (s.emaFast.value === null || s.emaSlow.value === null) return false;
  if (s.emaFast.value <= s.emaSlow.value) return false;

  return true;
}

function shouldExit(state: BarsState, s: SymbolState, symbol: string, held: { qty: bigint; cost: bigint }, seq: number): boolean {
  const value = state.value(symbol, held.qty);

  // Take profit
  if (value * TP_DEN >= held.cost * TP_NUM) return true;

  // Stop loss
  if (value * SL_DEN <= held.cost * SL_NUM) return true;

  // Momentum dying (after min hold)
  const barsHeld = seq - s.entryBar;
  if (barsHeld > MIN_HOLD) {
    const momShort = momN(s, MOM_SHORT);
    if (momShort !== null && momShort < MOM_SHORT_EXIT_BELOW) return true;
  }

  // Time stop
  if (barsHeld >= TIME_STOP) return true;

  return false;
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      update(bar);
      fresh.add(bar.symbol);
    }

    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = symbols.get(symbol);
      if (!s) continue;

      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (shouldExit(state, s, symbol, held, batch.seq)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else if (shouldEnter(s)) {
        entries.push(symbol);
        s.entryBar = batch.seq;
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;

    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }

    return orders;
  },
});
