# btc-race-24h-0603

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/cgxaltarm/btc-race-24h-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/cgxaltarm/btc-race-24h-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A bot that trades Coinbase Wrapped BTC (cbBTC) minute by minute on 1-minute on-chain prices with $1,000 of paper money. Deep dip-buy mean-reversion: it buys dips of 1.50% or more off the trailing 120-minute high (with a 4-hour trend filter), and sells at +0.80% from its fill, at a -1.00% stop, or after 240 bars. Built for the make.fun bounty "Race a BTC trading bot live for 24 hours".

## Run it

```sh
node main.ts
```

No dependencies, no network. Reads bars-replay/v1 JSON lines on stdin and answers with buy/sell orders on stdout.

---

<sub>Entered on [make.fun](https://make.fun/bounty/btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
