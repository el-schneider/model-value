---
name: model-value
description: Pick the best or best-value model on a multi-vendor AI subscription (GitHub Copilot, OpenCode Go, OpenCode Go Plus) for a task. Use when choosing a Copilot or OpenCode Go model, comparing model cost vs. benchmark score, or picking a model for a subagent or worker on one of these subscriptions.
---

# model-value

Ranks the models of a subscription plan by benchmark score and by what a task costs on that plan. Read-only: no inference, no quota use, no account changes.

Requires `model-value` on PATH (`npm install -g model-value`). Copilot also needs `gh auth login` or `GITHUB_TOKEN`; OpenCode Go needs no credentials.

## Plans

- `github-copilot` (alias `copilot`): ranks by `costUsd` per task (AI credits = USD × 100) over the models the account enables.
- `opencode-go`, `opencode-go-plus`: rank by share of the model's monthly limit per task; the readable number is `tasksPerMonth`. Go and Go Plus limits differ per model, so their rankings differ. Name the tier the user has; never guess it.

Without a plan, the CLI runs the single plan it detects (gh/token variables for Copilot; `OPENCODE_API_KEY`, opencode or pi `auth.json` for Go). An OpenCode key yields both Go tiers, so it exits `1` and lists the commands: then ask the user which plan they have, or pass the plan the user named.

## Commands

Always use `--json`. One object on stdout; errors as `{"error": "..."}` on stderr. Exit `0` results, `1` error, `2` nothing rankable.

```sh
model-value <plan> --json                       # best value: score frontier, cheapest first
model-value <plan> best --json                  # best models for coding, strongest first
model-value <plan> --json --min-score N         # first row = cheapest model at or above N
model-value <plan> --json --input 200000 --cached-input 150000 --output 8000   # workload shape
model-value copilot best --json --models claude-opus-5.5,gpt-6-sol   # compare a shortlist
model-value copilot best --json --all           # published Copilot catalog, ignores eligibility
model-value <plan> --json --offline             # no network; accepts stale snapshot
model-value <plan> refresh                      # force-refresh every source
```

Options: `--source aa|arena`, `--min-score N`, `--margin N` (value alternatives; default 5 for aa, 50 for arena; 0 = none), `--all-versions` (keep older family members as alternatives), `--top 1..100`, `--input/--cached-input/--cache-write/--output N` (cached and write are subsets of input), `--models a,b`, `--mapping FILE` (JSON `{modelId: benchmarkSlug}` to fix a match), `--cache FILE`, `--all` (Copilot: published catalog; no effect for Go). Copilot only: `--host corp.ghe.com` (or `GH_HOST`), `--user LOGIN` (that gh account's token; ignores token variables).

## Score sources

- `aa`: Artificial Analysis Intelligence Index, scale ~0–70. Default when `ARTIFICIAL_ANALYSIS_API_KEY` is set.
- `arena`: LMArena WebDev Elo (human preference on web-app coding tasks), scale ~1300–1850. Default without a key; needs no signup.

`source` in the result names the active one. In `value` mode the other source, when available (Arena always; AA only with a key), acts as a second opinion for alternatives: `hedge` names it and its margin, scaled from `--margin` (5 AA ↔ 50 Elo). Offline without its cached data, `hedge` is `null`. Scales differ: never compare scores across sources, and pick `--min-score` for the active scale.

## Reading the result

- `plan`: `id`, `label`, `provider`.
- `models[]`: ranked. `id` is the plan's model ID; `dispatchId` is `<provider>/<id>` (`github-copilot/...` or `opencode-go/...`, also for Go Plus) for tools taking a provider/model string.
- `models[].score`, `costUsd`, `rates` (per-million-token prices), `rankingCost` (the value the frontier compares).
- Copilot rows: `aiCredits` (USD × 100); `rankingCost` = `costUsd`.
- Go rows: `limitUsd` (the model's monthly limit; `null` = unlimited), `tasksPerMonth` (`limitUsd / costUsd`; `null` when unlimited), `unlimited`, `offPeak` (ranked at off-peak prices; peak hours cost more). `rankingCost` = `costUsd / limitUsd`, `0` when unlimited. `tasksPerMonth` assumes only that model is used; all models draw on one allowance, each weighted by its limit. It is not remaining quota.
- `models[].benchmark.name`: the exact variant scored, including reasoning effort. Quote it with the score.
- In `value` mode (the default), `models[]` is the frontier plus close alternatives. Frontier rows: each costs more (Go: uses more of the allowance) and scores higher than the previous one. Rows with `alternativeTo: <id>` follow that frontier row: they score within `margin` of it (or, when `hedge` is set, within `hedge.margin` on the second source), cost less than the next frontier row, and have no newer same-family model listed (models.dev `family`; `--all-versions` keeps them). At most 3 per row. `closeOn` lists the sources (`aa`, `arena`) that put the model close; quote it. `total` counts frontier rows; `--top` limits frontier rows. Models not listed are beaten on both; `dominated` counts them, and they are not in `skipped[]`.
- `skipped[]`: excluded models and why (no price, no benchmark match, workload exceeds limits). Never guess for these; a `--mapping` can fix a missing match.
- `eligibility` (Copilot only): `enabledCount`, `fetchedAt`, `selection` (`model-picker` or `enabled-policy`).
- `stale: true`: snapshot older than 6 h. Run `model-value <plan> refresh` unless offline is required.
- `snapshotId`: SHA-256 of the data; same snapshot plus same options gives the same order.

## Rules

- Copilot: only `models[]` from a non-`--all` run are usable on this account. `--all` output and `skipped[]` are not.
- OpenCode Go: every subscriber gets the same models; there is no account check. Models the API serves without a published limit are not ranked.
- Scores measure benchmarks, not task success. Token cost is an estimate, not a bill; it ignores subscription fees and remaining quota.
- Default workload is 100k input / 10k output, no cache hits. Pass the real shape when known.
- Rankings do not fall back to the catalog on auth errors. On a Copilot `{"error": ...}` mentioning the token, tell the user to run `gh auth login` or set `COPILOT_GITHUB_TOKEN` to a fine-grained PAT with the Copilot Requests permission. Copilot rejects classic PATs (`ghp_`); one in `GH_TOKEN`/`GITHUB_TOKEN` is skipped and reported in `eligibility.skippedTokens`. If the token belongs to the wrong account, rerun with `--user LOGIN`.
- An error saying the OpenCode Go docs changed shape means the published limits could not be read. Report it; do not rank Go from other sources.

## Data

- Copilot eligibility: Copilot `/models` (internal endpoint), cached 15 min, keyed to the token. Disabled, unconfigured, non-picker, and non-tool-calling models are excluded.
- Copilot prices: https://models.dev/api.json, `github-copilot` provider. Community-maintained; billing reference at https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing. Long-context rates apply above the published threshold.
- OpenCode Go prices and limits: the "Usage limits" tables for Go and Go Plus in https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx (rendered at https://opencode.ai/docs/go/); display names map to IDs through its "Endpoints" table. Parsed strictly; any shape change is an error. Context-tier rows become long-context rates; peak rows are dropped in favour of off-peak. models.dev `opencode-go` adds token limits and family metadata where known.
- Scores come from [model-frontier](https://github.com/el-schneider/model-frontier), cached 24 h in `$XDG_CACHE_HOME/model-frontier/` and shared with its CLI.
- AA: https://artificialanalysis.ai/api/v2/language/models/free with `ARTIFICIAL_ANALYSIS_API_KEY`. Subject to https://artificialanalysis.ai/data-api; do not redistribute snapshots.
- Arena: `webdev` config, `latest` split, `overall` category of https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset (CC BY 4.0).
- Matching: IDs normalized (`.`/`_` to `-`). AA: exact slug, plus explicit aliases for a few Claude reasoning variants. Arena: exact name or name plus effort/date/harness suffix (`-high`, `-max`, `-20251001`, ` (codex-harness)`); the best-scoring variant wins. No fuzzy matching.
- Cost: `(uncached × input + cached × cacheRead + writes × cacheWrite + output × output) / 1e6` USD.
- Snapshot: `$XDG_CACHE_HOME/model-value/snapshot-<plan>-<source>.json` (or `MODEL_VALUE_CACHE`, one exact file), Copilot eligibility sidecar `.eligibility.json` beside it (`.eligibility-pi-login.json` for the pi extension). Both mode 0600; tokens and keys are never written.

## pi extension

`pi install model-value` registers a `model_value` tool (options in camelCase: `plan` (`github-copilot`, `copilot`, `opencode-go`, `opencode-go-plus`; default: the one plan logged in to pi, required for Go), `mode` (`value` default, or `best`), `source`, `minScore`, `margin`, `allVersions`, `input`, `cachedInput`, `cacheWrite`, `output`, `top`, `all`, `offline`) and a `/model-value [plan] [value|best]` command that ranks, then asks before switching the session model. Without a plan, the command asks which plan when several are possible. The tool intersects the ranking with pi's logged-in models of that plan; `all` ranks the published catalog instead. Copilot eligibility comes from pi's Copilot login (`tokenSource: "pi login"`), not from gh or token variables; a matching result is reused for 15 minutes and expires when pi's token rotates; for Copilot, `offline` requires `all`. On an auth error, tell the user to run `/login` in pi. The tool returns `dispatchId`s; it never dispatches anything itself.
