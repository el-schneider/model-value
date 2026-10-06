---
name: model-value
description: Pick the best or best-value model on a multi-vendor AI subscription (GitHub Copilot, OpenCode Go, OpenCode Go Plus) for a task. Use when choosing a Copilot or OpenCode Go model, comparing model cost vs. benchmark score, or picking a model for a subagent or worker on one of these subscriptions.
---

# model-value

Ranks the models of a subscription plan by benchmark score and by what a task costs on that plan. Read-only: no inference, no quota use, no account changes.

Requires `model-value` on PATH (`npm install -g model-value`). Copilot also needs `gh auth login` or `GITHUB_TOKEN`; OpenCode Go needs no credentials.

## Plans

- `github-copilot` (alias `copilot`): ranks by `costUsd` per task over the models this account enables.
- `opencode-go`, `opencode-go-plus`: rank by `tasksPerMonth` on the model's monthly limit. The two tiers have different limits and rankings. Use the tier the user named; never guess it. "OpenCode" alone does not name a tier: ask Go or Go Plus.

Without a plan the CLI picks the one plan it detects. If it finds several, it exits `1` and lists them: ask the user which plan they have.

## Commands

Always pass `--json`. Result is one object on stdout; errors are `{"error": "..."}` on stderr. Exit `0` results, `1` error, `2` nothing rankable.

```sh
model-value <plan> --json                       # best value: cheapest first, each row scores higher
model-value <plan> best --json                  # strongest first
model-value <plan> --json --min-score N         # first row = cheapest model scoring >= N
model-value <plan> --json --source arena --min-score 1500   # threshold on the Arena scale
model-value <plan> --json --input 300000 --cached-input 250000 --output 20000   # real workload
model-value copilot best --json --models a,b    # compare a shortlist
model-value <plan> refresh                      # re-fetch data when the result is stale
```

Default workload is 100k input / 10k output, no cache. Pass the real shape when known; `--cached-input` is part of `--input`. Other options: `model-value --help`.

## Scores

- `aa` (Artificial Analysis Intelligence Index, ~0–70): default when `ARTIFICIAL_ANALYSIS_API_KEY` is set.
- `arena` (LMArena WebDev Elo, ~1300–1850): default otherwise.

`source.id` in the result names the active scale. A `--min-score` must match the scale: pass `--source aa` for 0–70 thresholds, `--source arena` for Elo thresholds. Never compare scores across sources.

## Reading the result

- `models[]` is ranked. Hand `dispatchId` (`<provider>/<id>`) to tools that take a provider/model string.
- Quote `score` together with `benchmark.name` (the exact variant scored, e.g. reasoning effort).
- Copilot: `costUsd` per task (`aiCredits` = USD × 100).
- Go: `tasksPerMonth` = tasks the monthly limit covers if only this model is used. It is not remaining quota. `unlimited: true` means no limit.
- Value mode: rows without `alternativeTo` form the frontier; each costs more (Go: uses more of the allowance) and scores higher than the one before. A row with `alternativeTo: <id>` scores close to that frontier row and costs at least as much, but less than the next frontier row; `closeOn` names the source(s) that rate it close.
- `skipped[]`: models excluded and why. Do not guess scores or prices for them. A `--models` entry the Copilot account does not enable shows as `Not enabled on this account`. Fix a missing benchmark match with `--mapping FILE` (JSON `{modelId: benchmarkSlug}`).
- `stale: true`: run `model-value <plan> refresh` first.

## Rules

- Copilot: only `models[]` of a run without `--all` are usable on this account. `--all` lists the public catalog, not what the user can use.
- Scores measure benchmarks, not task success. Cost is an estimate, not a bill.
- On a Copilot token error: tell the user to run `gh auth login`, or set `COPILOT_GITHUB_TOKEN` to a fine-grained PAT with Copilot Requests permission. Classic PATs (`ghp_`) are rejected. Wrong account: rerun with `--user LOGIN`.
- If the error says the OpenCode Go docs changed shape, report it. Do not rank Go from other sources.

## pi extension

The `model_value` tool takes `plan`, `all`, `offline` and the ranking options in camelCase (`mode`, `source`, `minScore`, workload sizes, `top`; see its schema). It has no `models`, `mapping`, `host` or `user`. It uses pi's login, not gh. On an auth error, tell the user to run `/login` in pi. `/model-value [plan] [value|best]` ranks and then asks before switching the session model.
