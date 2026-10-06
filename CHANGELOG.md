# Changelog

model-value continues [copilot-value](https://github.com/el-schneider/copilot-value). Releases up to 0.6.0 are in [its changelog](https://github.com/el-schneider/copilot-value/blob/main/CHANGELOG.md).

## Unreleased

## 0.1.0

- Renamed to `model-value`. The plan is the first argument: `model-value github-copilot` (alias `copilot`), `model-value opencode-go`, `model-value opencode-go-plus`. Without a plan, the one detected plan runs; none or several print the commands to choose from.
- OpenCode Go and Go Plus: ranked by tasks per month (the model's monthly limit ÷ cost per task), with prices and limits parsed from the OpenCode Go docs source. Docs shape changes fail loudly.
- OpenCode Go detection reuses `OPENCODE_API_KEY` or the key in opencode's or pi's `auth.json`.
- pi: the tool is `model_value` with a `plan` parameter; `/gh-model` is now `/model-value [plan] [value|best]`.
- Cache directory and variable: `$XDG_CACHE_HOME/model-value/`, `MODEL_VALUE_CACHE`.
