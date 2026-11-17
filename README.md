[![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/ayilinalin/btc-race-24h-20261117-0603-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/ayilinalin/btc-race-24h-20261117-0603-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603)

# DipSnap — btc-race-24h-20261117-0603

Dip-recovery trading bot for [make.fun's btc-race-24h-20261117-0603](https://make.fun/bounty/btc-race-24h-20261117-0603): races a cbBTC/USDC bot on 1-minute bars, $1,000 paper money, long only.

## Strategy

The dev window (2026-11-16 06:03Z – 2026-11-17 06:03Z) is a tight range
($63,874–$65,467, +0.49% total, max drawdown -2.12%). Trend systems whipsaw
to death here (EMA 8/21 cross: -$106; hourly momentum: -$31..-$73), so the
bot buys sharp drops and takes a quick profit before the range rolls back:

- **Primary** — 60-bar drop ≥ 1.0% + 5-bar bounce ≥ +0.05%: TP +0.9%, SL -0.5%.
- **Secondary** — 30-bar drop ≥ 0.6% + 5-bar bounce ≥ +0.03%: TP +0.7%, SL -0.5%.
- **Fallback** — arms only after 960 bars with zero fills (a quiet race window
  still needs ≥ 1 trade for the guardrail): 30-bar drop ≥ 0.4%,
  bounce ≥ +0.03%: TP +0.6%, SL -0.4%.

Every leg exits on TP, SL, or a 600-bar time stop. Full-size buys (100% cash),
one position at a time.

Local backtest on the dev window (harness fill model: 4 bps fee + 2 bps
slippage + constant-product impact): **net PnL +$20.64, 3 round trips,
max drawdown -0.66%**, positive on both halves (H1 +$14.64, H2 +$5.95).

## Layout

- `main.ts` — the bot (Node 22, stdlib only + vendored SDK).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  `agent-fun/bars-replay/v1` shim.

Deterministic: pure function of the bars. No clock, no environment, no randomness.

## License

MIT — see [LICENSE](LICENSE).
