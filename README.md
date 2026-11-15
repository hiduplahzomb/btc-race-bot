# btc-race-bot

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/hiduplahzomb/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/hiduplahzomb/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

DipGuard is a regime-gated dip-bounce trading bot for cbBTC on the make.fun 24-hour BTC race. It buys confirmed dips only when the 4-hour regime favours a bounce, rides winners behind a trailing stop, and cuts losses with a wide hard stop and drawdown brakes.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ykaz8n5y&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>

## How it works

The bot speaks the `agent-fun/bars-replay/v1` protocol (NDJSON over stdin/stdout) and trades cbBTC/USDC on 1-minute bars, long-only, from a $1,000 paper account. The strategy is in `strategy.ts` (`main.ts` is the thin protocol wrapper; `vendor/makefun-bars.ts` is the kit's SDK shim, byte-identical).

**DipGuard, in one line:** BTC flushes hard and bounces — buy the flush only once the bounce has started, only in a regime where dips bounce, cut the trade when it does not follow through, and let the winners run behind a trailing stop.

- **Regime gate (the trend component).** A dip is bought only when the 240-bar (4h) return says the regime favours it: above −0.5% (uptrend or flat tape, where dips are noise to buy) or below −2.5% (a mature washout, where the selling is exhausted). Between the two the downtrend is fresh and the dip is usually the start of a bigger drop, not the bottom — no entry. On the dev window this gate alone separates the entries that bounced +4% from the ones that cascaded −4% further.
- **Entry (flat only).** The close fell 1.2% or more over 30 bars and the bounce is confirmed (this close above the last close). No oversold filter: on the dev window it filtered out the best entries.
- **Sizing.** 65–85% of equity, growing with dip depth, shrinking with volatility (ATR) and after losses; never all-in.
- **Exits.** A wide 1.5% hard stop under the average entry (the 1-minute tape routinely extends a dip 1%+ past the signal before it turns, so a tight stop just pays the round trip and misses the bounce), a trailing stop that arms at +0.6% and trails 0.5% under the peak, and a 3-hour time exit.
- **Brakes.** A 20-bar cooldown after a stop-out (60 bars after two in a row, then the streak resets), no entries in dead chop (the 30-bar range under 0.3% cannot pay the ~30 bps round trip), half size after a 3% equity drawdown, no new entries after 5%.
- **Determinism.** The strategy is a pure function of the bar stream: float64 math only, no clock, no environment, no randomness, no external calls. Two runs reproduce byte for byte.

## Dev results

Graded locally with the kit's harness (`grade-local --driver process`) on the 24h dev window 2026-11-14T08:28Z → 2026-11-15T08:28Z, a **down day** (BTC $67,216 → $64,524, −4.00%):

| Bot | Net PnL | Trades | Win rate | Max drawdown |
| --- | --- | --- | --- | --- |
| **DipGuard (this bot)** | **+$26.73** | 3 (6 fills) | 100% | −1.29% |
| buy-and-hold | −$44.01 | 1 | 0% | −7.92% |
| momentum | −$40.92 | 1 | 0% | −7.92% |
| ema-cross | −$134.95 | 63 | 3% | −13.65% |
| rsi-bollinger | −$57.37 | 12 | 17% | −6.77% |
| adx-momentum | −$86.60 | 35 | 17% | −8.82% |
| hold-cash | $0.00 | 0 | — | 0% |

DipGuard is the only one of the seven that clears the dev gate (net PnL > $0 after all fees), with the lowest drawdown of any trading bot. Fees paid: $1.64; at 2× fees the net PnL is still +$25.08. All four partial sub-windows of the dev day are also positive, and the chosen parameters sit on a flat plateau in the sweep (not a sharp peak).

## Grade it yourself

From the competition kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/btc-race-bot --driver process
```
