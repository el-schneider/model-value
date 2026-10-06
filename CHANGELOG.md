# Changelog

model-value continues [copilot-value](https://github.com/el-schneider/copilot-value). Releases up to 0.6.0 are in [its changelog](https://github.com/el-schneider/copilot-value/blob/main/CHANGELOG.md).

## Unreleased

- Uses model-frontier 0.2.0. Rankings and the shared score cache are unchanged.

## 0.1.1

- Copilot: a model in `--models` that your account does not enable is now listed under excluded models with the reason `Not enabled on this account`, instead of being silently left out.
- The agent skill is half as long and easier for small models to follow. Data sources moved to the README.

## 0.1.0

- First release: ranks the models of GitHub Copilot, OpenCode Go and OpenCode Go Plus by benchmark score and by what a task costs on that plan. Try `npx model-value opencode-go`.
- GitHub Copilot (`github-copilot` or `copilot`): cost per task in USD and AI credits, over the models your account enables (gh login).
- OpenCode Go (`opencode-go`, `opencode-go-plus`): tasks per month per model, from the monthly limits published at https://opencode.ai/docs/go/. No login needed.
- Without a plan argument, it runs the one plan it finds in your logins: gh for Copilot; `OPENCODE_API_KEY`, opencode's or pi's `auth.json` for Go.
- Scores: LMArena WebDev Elo without a key, Artificial Analysis Intelligence Index with `ARTIFICIAL_ANALYSIS_API_KEY`.
- pi: `pi install model-value` adds the `model_value` tool and the `/model-value` command.
- Replaces copilot-value: `model-value copilot` gives the same ranking.
