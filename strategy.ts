// DipGuard: a regime-gated dip-bounce bot for the make.fun cbBTC 1-minute
// race (agent-fun/bars-replay/v1).
//
// Idea, in one line: BTC flushes hard and bounces; buy the flush only once
// the bounce has started, only in a regime where dips bounce, cut the trade
// when it does not follow through, and let the winners run behind a trailing
// stop.
//
//   - Regime gate (the trend component). A dip is bought only when the 240-bar
//     (4h) return says the regime favours it: above regimeUp (an uptrend or a
//     flat tape, where dips are noise to buy) or below regimeWashout (a mature
//     washout, where the selling is exhausted). Between the two the downtrend
//     is fresh and the dip is usually the start of a bigger drop, not the
//     bottom: no entry. On the dev window this gate alone separates the
//     entries that bounced +4% from the ones that cascaded -4% further.
//   - Entry (flat only). DIP-BOUNCE: the close fell dipPct or more over
//     dipBars bars and the bounce is confirmed (this close above the last
//     close). No oversold filter: it filtered out the best entries on the dev
//     window.
//   - Sizing: a fraction of equity that grows with the dip's depth and shrinks
//     with volatility (ATR) and after losses; never all-in.
//   - Exits (holding): a WIDE hard stop stopPct under the average entry (the
//     1-minute tape routinely extends a dip 1%+ past the signal before it
//     turns, so a tight stop just pays the round trip and misses the bounce),
//     a trailing stop that arms at trailArmPct of profit and trails trailPct
//     under the peak, and a time exit at maxHoldBars.
//   - Brakes: a cooldown after a stop-out (longer after two in a row, then the
//     streak resets: a hard block after two stops locked the bot out of the
//     dev window's biggest recovery), no entries in dead chop (the 30-bar
//     range under chopRangePct cannot pay the ~30 bps round trip), half size
//     after a 3% equity drawdown, no new entries after 5%.
//   - No entries in the last bars of the window: a trade opened there has no
//     time to work before the forced flatten.
//
// Everything here is deterministic float64 math on the bars alone: no clock,
// no environment, no randomness. Prices are the harness's raw units (any
// scale); every rule is a ratio, so the scale never matters.

export interface DipGuardParams {
  dipBars: number;
  dipPct: number;
  /** Consecutive up closes that confirm a dip-bounce entry. */
  confirmBars: number;
  /** Lookback for the regime gate (bars). */
  regimeBars: number;
  /** Regime gate: buy dips when the regime return is above this (up/flat). */
  regimeUp: number;
  /** Regime gate: or below this (a mature washout). Between the two, no entry. */
  regimeWashout: number;
  rsiPeriod: number;
  rsiOversold: number;
  bbPeriod: number;
  bbStd: number;
  /** Whether a dip entry also needs the tape oversold (RSI or Bollinger). */
  requireOversold: boolean;
  stopPct: number;
  trailArmPct: number;
  trailPct: number;
  maxHoldBars: number;
  baseSize: number;
  maxSize: number;
  minSize: number;
  cooldownBars: number;
  /** Cooldown after two consecutive stop-outs (the streak then resets). */
  streakCooldownBars: number;
  chopRangePct: number;
  chopBars: number;
  lossBrakePct: number;
  stopBrakePct: number;
  lastEntryBar: number;
  atrPeriod: number;
  atrHot: number;
  atrVeryHot: number;
}

export const DEFAULT_PARAMS: DipGuardParams = {
  dipBars: 30,
  dipPct: 0.012,
  confirmBars: 1,
  regimeBars: 240,
  regimeUp: -0.005,
  regimeWashout: -0.025,
  rsiPeriod: 14,
  rsiOversold: 30,
  bbPeriod: 20,
  bbStd: 2,
  requireOversold: false,
  stopPct: 0.015,
  trailArmPct: 0.006,
  trailPct: 0.005,
  maxHoldBars: 180,
  baseSize: 0.65,
  maxSize: 0.85,
  minSize: 0.3,
  cooldownBars: 20,
  streakCooldownBars: 60,
  chopRangePct: 0.003,
  chopBars: 30,
  lossBrakePct: 0.03,
  stopBrakePct: 0.05,
  lastEntryBar: 1380,
  atrPeriod: 14,
  atrHot: 0.0025,
  atrVeryHot: 0.004,
};

export interface BarInput {
  o: number;
  h: number;
  l: number;
  c: number;
}

/** The account as the caller sees it; prices in raw units, money in quote units. */
export interface AccountInput {
  /** Cash in quote units (micro-USDC). */
  cash: number;
  /** Equity in quote units. */
  equity: number;
  /** Equity at the start of the window, for the loss brakes. */
  startEquity: number;
  /** The open position, if any: average entry price (raw units) and quantity. */
  position: { entryPrice: number; qty: number } | null;
  /** Bars seen so far in the window (0-based index of the bar being decided). */
  barIndex: number;
}

export type Decision =
  | { action: 'buy'; frac: number; reason: string }
  | { action: 'sell'; reason: string }
  | { action: 'hold' };

export class DipGuard {
  readonly params: DipGuardParams;
  private closes: number[] = [];
  private highs: number[] = [];
  private lows: number[] = [];
  private rsiGain = 0;
  private rsiLoss = 0;
  private rsiSeeded = false;
  private rsiWarm: number[] = [];
  private prevClose: number | null = null;
  private trSum = 0;
  private trCount = 0;
  private trs: number[] = [];
  /** Peak close since the current position opened (raw units). */
  private peak = 0;
  /** Bars held in the current position. */
  private heldBars = 0;
  /** Bars left in the post-stop cooldown. */
  private cooldown = 0;
  /** Whether we held a position on the last bar (to spot a close). */
  private wasHolding = false;
  /** Consecutive stop-outs, for the loss brake. */
  private stopStreak = 0;

  constructor(params: DipGuardParams = DEFAULT_PARAMS) {
    this.params = params;
  }

  private get rsi(): number | null {
    if (!this.rsiSeeded) return null;
    if (this.rsiLoss === 0) return 100;
    if (this.rsiGain === 0) return 0;
    const rs = this.rsiGain / this.rsiLoss;
    return 100 - 100 / (1 + rs);
  }

  private get atr(): number | null {
    if (this.trCount < this.params.atrPeriod) return null;
    return this.trSum / this.params.atrPeriod;
  }

  private bollinger(): { mid: number; lower: number } | null {
    const n = this.params.bbPeriod;
    if (this.closes.length < n) return null;
    const slice = this.closes.slice(-n);
    const mid = slice.reduce((a, x) => a + x, 0) / n;
    let variance = 0;
    for (const x of slice) variance += (x - mid) * (x - mid);
    const sd = Math.sqrt(variance / n);
    return { mid, lower: mid - this.params.bbStd * sd };
  }

  private retBars(n: number): number | null {
    if (this.closes.length <= n) return null;
    const then = this.closes[this.closes.length - 1 - n]!;
    return this.closes[this.closes.length - 1]! / then - 1;
  }

  private rangeBars(n: number): number | null {
    if (this.closes.length < n) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = this.closes.length - n; i < this.closes.length; i++) {
      if (this.highs[i]! > hi) hi = this.highs[i]!;
      if (this.lows[i]! < lo) lo = this.lows[i]!;
    }
    return hi / lo - 1;
  }

  decide(bar: BarInput, account: AccountInput): Decision {
    const p = this.params;
    const c = bar.c;

    // --- fold the bar into the indicators
    if (this.prevClose !== null) {
      const change = c - this.prevClose;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      if (!this.rsiSeeded) {
        this.rsiWarm.push(change);
        if (this.rsiWarm.length === p.rsiPeriod) {
          let g = 0;
          let l = 0;
          for (const d of this.rsiWarm) {
            if (d > 0) g += d;
            else l -= d;
          }
          this.rsiGain = g / p.rsiPeriod;
          this.rsiLoss = l / p.rsiPeriod;
          this.rsiSeeded = true;
        }
      } else {
        this.rsiGain = (this.rsiGain * (p.rsiPeriod - 1) + gain) / p.rsiPeriod;
        this.rsiLoss = (this.rsiLoss * (p.rsiPeriod - 1) + loss) / p.rsiPeriod;
      }
      let tr = bar.h - bar.l;
      const a = Math.abs(bar.h - this.prevClose);
      const b = Math.abs(bar.l - this.prevClose);
      if (a > tr) tr = a;
      if (b > tr) tr = b;
      this.trs.push(tr);
      this.trSum += tr;
      this.trCount++;
      if (this.trs.length > p.atrPeriod) this.trSum -= this.trs.shift()!;
    }
    this.prevClose = c;
    this.closes.push(c);
    this.highs.push(bar.h);
    this.lows.push(bar.l);
    // Keep only what the longest lookback needs.
    const keep = Math.max(p.regimeBars, p.bbPeriod, p.dipBars, p.chopBars) + 2;
    if (this.closes.length > keep + 60) {
      this.closes.splice(0, this.closes.length - keep - 60);
      this.highs.splice(0, this.highs.length - keep - 60);
      this.lows.splice(0, this.lows.length - keep - 60);
    }

    if (this.cooldown > 0) this.cooldown--;

    // --- position bookkeeping
    const holding = account.position !== null;
    if (holding && !this.wasHolding) {
      // A fill opened the position since the last bar.
      this.peak = c;
      this.heldBars = 0;
    }
    if (!holding && this.wasHolding) {
      this.peak = 0;
      this.heldBars = 0;
    }
    this.wasHolding = holding;

    if (holding && account.position !== null) {
      this.heldBars++;
      if (c > this.peak) this.peak = c;
      const entry = account.position.entryPrice;
      const pnl = c / entry - 1;
      const peakPnl = this.peak / entry - 1;
      // Hard stop.
      if (pnl <= -p.stopPct) {
        this.stopStreak++;
        if (this.stopStreak >= 2) {
          // Two stops in a row: pause for a while, then reset. A hard block
          // here locked the bot out of the dev window's biggest recovery.
          this.cooldown = p.streakCooldownBars;
          this.stopStreak = 0;
        } else {
          this.cooldown = p.cooldownBars;
        }
        return { action: 'sell', reason: 'stop' };
      }
      // Trailing stop, once armed.
      if (peakPnl >= p.trailArmPct && c <= this.peak * (1 - p.trailPct)) {
        this.stopStreak = 0;
        return { action: 'sell', reason: 'trail' };
      }
      // Time exit.
      if (this.heldBars >= p.maxHoldBars) {
        this.stopStreak = 0;
        return { action: 'sell', reason: 'time' };
      }
      // No trend exit: dip entries are counter-trend by design. The stop, the
      // trailing stop and the time exit are the exits; the regime gate
      // handles the trend at entry time instead.
      return { action: 'hold' };
    }

    // --- flat: entries
    if (account.barIndex >= p.lastEntryBar) return { action: 'hold' };
    if (this.cooldown > 0) return { action: 'hold' };
    const equityDd = account.equity / account.startEquity - 1;
    if (equityDd <= -p.stopBrakePct) return { action: 'hold' };

    const ret30 = this.retBars(p.dipBars);
    const retRegime = this.retBars(p.regimeBars);
    const bb = this.bollinger();
    const rsi = this.rsi;
    const range = this.rangeBars(p.chopBars);
    if (ret30 === null || retRegime === null || bb === null || rsi === null || range === null) {
      return { action: 'hold' };
    }
    // Dead chop cannot pay the round trip.
    if (range < p.chopRangePct) return { action: 'hold' };
    // Regime gate: buy dips in an uptrend/flat tape or after a mature
    // washout; a fresh downtrend's dips are the start of a bigger drop.
    const regimeOk = retRegime > p.regimeUp || retRegime < p.regimeWashout;
    if (!regimeOk) return { action: 'hold' };

    let confirmed = true;
    for (let i = 0; i < p.confirmBars; i++) {
      const idx = this.closes.length - 1 - i;
      if (this.closes[idx]! <= this.closes[idx - 1]!) {
        confirmed = false;
        break;
      }
    }
    const oversold = rsi < p.rsiOversold || c < bb.lower;
    // Size: grows with dip depth, shrinks with volatility and after losses.
    let frac = p.baseSize;
    const atr = this.atr;
    if (atr !== null) {
      const atrPct = atr / c;
      if (atrPct > p.atrVeryHot) frac *= 0.5;
      else if (atrPct > p.atrHot) frac *= 0.7;
    }
    if (equityDd <= -p.lossBrakePct) frac *= 0.5;
    if (frac < p.minSize) frac = p.minSize;

    // Dip-bounce entry. The oversold filter is off by default: on the dev
    // window it filtered out the best entries (the tape had already bounced
    // off its lows by the time the signal fired), while the dip depth plus
    // one confirming up close carried the edge on its own.
    if (ret30 <= -p.dipPct && (!p.requireOversold || oversold) && confirmed) {
      const depth = Math.min(1, (-ret30 - p.dipPct) / 0.01);
      frac = frac + (p.maxSize - frac) * depth * 0.5;
      if (frac > p.maxSize) frac = p.maxSize;
      return { action: 'buy', frac, reason: retRegime < p.regimeWashout ? 'dip-washout' : 'dip-bounce' };
    }
    return { action: 'hold' };
  }
}
