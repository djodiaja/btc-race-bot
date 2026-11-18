# BTC Race Bot — Momentum Reversal Strategy

[![make.fun entry](https://img.shields.io/badge/make.fun-entry-blue)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Entry for [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261118-1444) on make.fun

## Strategy

**Momentum Reversal with Confirmation** — a long-only mean reversion strategy tuned for 1-minute cbBTC bars.

Core logic:
- Waits for a confirmed dip: 20-bar momentum < -0.4%
- Enters only after bounce is underway: 5-bar momentum > 0.08%
- Requires micro-uptrend: EMA(3) > EMA(8)
- Takes profit at 1.0%, stops at 0.5%, time-stops at 2.5 hours

## Run

```
node main.ts
```

Requires Node 22. Standard library only — no packages to install.

## License

SPDX-License-Identifier: MIT
