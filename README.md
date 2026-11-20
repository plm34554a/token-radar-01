# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/plm34554a/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/plm34554a/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks protocols that record no token yet by what a token would be worth if each protocol's record stayed as it is, and gives every row a concrete farm plan. It reads the sealed DefiLlama snapshot, covers the 40-protocol watchlist whole, and adds every other pre-token protocol at or above $10M TVL that passes the watchlist's own product tests — 154 rows on this snapshot — while the tokenised protocols are set aside in a Live view with their real market caps.

## How the value model works

No flat multiple and no hand-picked names: the price of a launch is calibrated from the snapshot's own tokenised protocols, the peers whose tokens already trade.

- **Peers.** Every tokenised protocol with a market cap and a TVL prices at `mcap_usd / tvl_usd`, winsorised to [0.02, 4] so one outlier cannot bend the market. On this snapshot that is 128 peers at a median of 0.214× TVL.
- **Peer multiple.** Each category's median peer ratio, shrunk toward the market median by its peer count — `(n × category median + 6 × market median) / (n + 6)` — so a category priced off two tokens borrows the market's evidence. A category with no tokenised peers prices at the market median.
- **Chain factor.** The same shrinkage (k = 12) over the peers whose first chain matches the protocol's, expressed against the market median and clamped to [0.75, 1.33].
- **Growth multiplier.** `1 + clamp(change_7d, −50, +100) / 100 × 0.6`; an unreported change counts 0.
- **Maturity multiplier.** `0.80 + 0.40 × min(age_days, 1460) / 1460`, where age is how long the protocol has run with no token; an unreported age counts 365 days.

`implied = max(1, round(tvl_usd × peer multiple × chain factor × growth multiplier × maturity multiplier))`, with every multiplier rounded to 4 decimals first, so the dashboard can recompute each row from its displayed components and land on the exact number `board.json` carries — the detail view does this in the open. The model lives in `lib/model.ts` (`calibrate`, `impliedValue`, `growthMultiplier`, `maturityMultiplier`); farm plans are generated per protocol from its category playbook, chains, TVL-sized capital and age-sized hold (`farmSteps`), never from a per-name list.

The dashboard (`dashboard/`) is a static page with no network: a sortable, filterable board (search, category, chain, value band, token status), a detail drawer per protocol with the step-by-step pricing breakdown and its farm plan, and a model panel stating the calibration, including the per-category multiples table.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Run from the repository root with the kit's `input/` directory beside it (adjust the `--input` path to wherever the snapshot lives; in the grader the program reads `/input/snapshot.json` and writes `/output` by default). The run writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json`. Serve `out/` with any static file server, or open `out/dashboard/index.html` from disk, to read the radar. Node 22.18 or later, standard library only; the same snapshot always writes the same bytes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9321azde&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
