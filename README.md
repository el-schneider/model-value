# model-value

Get the most out of an AI subscription that serves models from many vendors: GitHub Copilot or OpenCode Go.

- Which model gives me the most for my plan? `model-value`
- Which model is strongest for coding? `model-value best`

These plans offer 30 models or more. The same task can use 100× more of your allowance on one model than on another, and the model pickers show no quality score. model-value ranks the plan's models by benchmark score and by what a task costs on that plan.

```
$ model-value opencode-go
Best value · OpenCode Go · 30 models · LMArena WebDev Elo
Each numbered row scores higher and gets fewer tasks per month than the one above. Indented: alternatives within 50 points in the same price tier.

#  MODEL                SCORE  TASKS/MO
1  mimo-v2.5             1438     3,571
2  hy3                   1507     3,030
3  glm-5.3-flash         1616     3,000
4  deepseek-v4.1-flash   1620     2,857
     mimo-v2.6-pro       1618       287
     gpt-6-luna          1579     1,000
5  hy4-preview           1633       276
     glm-5.3             1623        81
6  qwen3.8-max           1671        57
     grok-4.7            1638        57

Task: 100k input, 10k output. Tasks/mo: the model's monthly limit ÷ cost per task, if you used only that model.
Off-peak prices: deepseek-v4.1-flash. Peak hours cost more.
11 more models omitted: each is beaten on tasks per month and score by a listed model (model-value opencode-go best lists all).
```

Read-only: no inference calls, no quota spent, nothing changed on your account.

## Plans

| Plan | Ranks by | Account check |
|---|---|---|
| `github-copilot` (alias `copilot`) | Cost per task in USD (1 AI credit = $0.01) | Models your account enables, via gh login. `--all`: published catalog |
| `opencode-go` | Tasks per month: the model's monthly limit ÷ cost per task | None needed: prices and limits are public |
| `opencode-go-plus` | Same, with Go Plus limits (not a fixed multiple of Go) | None needed |

Without a plan, model-value looks for your logins and runs the one plan it finds. It finds Copilot through gh or a token variable, and OpenCode Go through `OPENCODE_API_KEY`, opencode's `auth.json` or pi's `auth.json`. An OpenCode key cannot tell Go from Go Plus, and the rankings differ, so with a Go key, or with several plans, it stops and prints the commands to choose from.

OpenCode Go weighs each model's spend by that model's monthly limit. Two models with the same token price can therefore differ 4× in tasks per month: GLM-5.2 has a $60 limit, GLM-5.3 $15. Prices and limits come from the [OpenCode Go docs](https://opencode.ai/docs/go/), parsed from their [source](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/go.mdx). If that page changes shape, model-value stops with an error instead of ranking on old numbers. Models with peak pricing are ranked at off-peak prices.

## Install

Node.js 22.19+. For Copilot: the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`), or `GITHUB_TOKEN` set.

Copilot token order: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then the gh login. With several gh accounts on one host, `--user LOGIN` uses that account's token and ignores the token variables. Copilot accepts gh OAuth tokens and [fine-grained PATs](https://github.com/settings/personal-access-tokens/new) with the **Copilot Requests** permission, but no classic PATs (`ghp_...`). A classic PAT in `GH_TOKEN` or `GITHUB_TOKEN` is skipped with a notice.

```sh
npm install -g model-value
```

## Use

```sh
model-value                          # detected plan, best value
model-value opencode-go-plus best    # strongest models on Go Plus
model-value copilot --input 200000 --cached-input 150000 --output 8000   # your workload shape
model-value opencode-go --margin 0   # strict frontier, no alternatives
model-value copilot --all-versions   # include older models of a listed family
model-value copilot best --models claude-opus-5.5,gpt-6-sol   # compare a shortlist
model-value copilot --host corp.ghe.com --user alice_corp     # an enterprise or second gh account
model-value opencode-go --verbose    # plus benchmark variants, exclusion reasons, timestamps
model-value opencode-go --json       # for scripts and agents
```

`--help` lists everything else. Scores are benchmarks, not your task, and cost is a token estimate, not a bill.

## Scores

Works without any key: scores come from the public [LMArena WebDev](https://lmarena.ai/leaderboard/webdev) leaderboard (human-preference Elo on coding tasks, [CC BY 4.0](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset)).

Set `ARTIFICIAL_ANALYSIS_API_KEY` ([free](https://artificialanalysis.ai/data-api)) to use the [Artificial Analysis](https://artificialanalysis.ai) Intelligence Index instead. Arena then acts as a second opinion: a model it rates close to the frontier also shows up as an alternative, tagged `arena`. `--source aa|arena` picks the ranking source explicitly. Copilot prices come from https://models.dev. Everything is cached for 6 hours; `model-value <plan> refresh` forces a fetch.

## Agents

Full JSON contract, caveats, and data sources: [skills/model-value/SKILL.md](skills/model-value/SKILL.md).

```sh
npx skills add el-schneider/model-value
```

Users of [pi](https://github.com/badlogic/pi-mono) get a `model_value` tool and `/model-value` command with `pi install model-value`. Both use the plans you are logged in to in pi. Copilot eligibility comes from pi's own Copilot login, including GitHub Enterprise logins, not from gh or token variables.

## License

[MIT](LICENSE)
