#!/usr/bin/env node
import { parseArgs, styleText } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { format, querySchema } from '../src/index.js';
import { query as getRankings, detectPlans } from '../src/query.js';
import { skippedTokenNotice } from '../src/copilot.js';
import { planFor, planIds, planAliases } from '../src/plans.js';

const names = { minScore: 'min-score', cachedInput: 'cached-input', cacheWrite: 'cache-write', allVersions: 'all-versions' };
const flags = Object.keys(querySchema.properties).filter(key => key !== 'mode');
const commands = ['value', 'best', 'refresh'];
const planWords = [...planIds, ...Object.keys(planAliases)];
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    ...Object.fromEntries(flags.map(key => [names[key] ?? key, { type: querySchema.properties[key].type === 'boolean' ? 'boolean' : 'string' }])),
    all: { type: 'boolean' }, host: { type: 'string' }, user: { type: 'string' },
    json: { type: 'boolean' }, verbose: { type: 'boolean' }, offline: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    cache: { type: 'string' }, mapping: { type: 'string' }, models: { type: 'string' },
  } });
  if (values.version) {
    console.log(createRequire(import.meta.url)('../package.json').version);
  } else if (values.help) {
    console.log(`model-value [PLAN] [value|best|refresh] [options]

Rank the models of a multi-vendor AI subscription by benchmark score and cost.

PLANS
  github-copilot     GitHub Copilot (alias: copilot). Cost per task in USD / AI credits.
                     Ranks the models your account enables (gh login); --all ranks the catalog.
  opencode-go        OpenCode Go ($10/mo). Tasks per month per model from the published
  opencode-go-plus   OpenCode Go Plus ($40/mo). monthly limits; no login needed.
  Without PLAN, model-value detects it from your logins (gh; OPENCODE_API_KEY, opencode or
  pi auth.json). It stops and lists the commands when it finds none or several.

COMMANDS
  value    Best value (default): the score frontier, cheapest first.
           Each row costs more (Go: uses more of the allowance) and scores higher than
           the one before; every model left out is beaten on both. Indented rows are close
           alternatives: within --margin points, same price tier, newest per family.
           With an AA key, Arena scores can also qualify an alternative; the
           tag after the row says which source put it close.
  best     Strongest models on the plan, cost alongside
  refresh  Re-fetch eligibility, prices and scores

No inference calls, no quota spent.

SCORES
  With ARTIFICIAL_ANALYSIS_API_KEY set: Artificial Analysis Intelligence Index.
  Without a key: LMArena WebDev Elo (public, coding-focused, no signup).
  --source aa|arena overrides. Scales differ; --min-score uses the active one.

EXAMPLES
  Best value on your detected plan:
    model-value

  Best models on OpenCode Go Plus:
    model-value opencode-go-plus best

  Cheapest Copilot model above a quality floor (first row):
    model-value copilot --min-score 1600 --source arena

  Your workload: 200k input, 150k of it cache reads, 8k output:
    model-value opencode-go --input 200000 --cached-input 150000 --output 8000

  Compare a shortlist, as JSON:
    model-value copilot best --models claude-opus-5.5,gpt-6-sol --json

  Published Copilot catalog instead of your subscription:
    model-value copilot best --all --top 5

  Cached data only, no network (stale data is marked):
    model-value opencode-go --offline --json

OPTIONS
  --source aa|arena        Score source; default aa if a key is set, else arena
  --min-score N            Exclude scores below N
  --margin N               Show models up to N points below a value row as alternatives;
                           higher = more alternatives. Default 5 (aa) or 50 (arena); 0 = none
  --all-versions           Also show older models of a family whose newer model is listed
  --input N                Total input, including cache; default 100000
  --cached-input N         Cache-read subset; default 0
  --cache-write N          Cache-write subset; default 0
  --output N               Output tokens; default 10000
  --top N                  1–100; default 10
  --models id,id           Narrow to exact IDs; never bypasses eligibility
  --mapping FILE           JSON object: model ID -> exact benchmark slug
  --cache FILE             Snapshot path (or MODEL_VALUE_CACHE)
  --offline                Use cached snapshot without network, even if stale
  --verbose                Also show timestamps, benchmark variants, exclusion reasons, caveats
  --json                   One JSON object on stdout
  --all                    Published catalog instead of your Copilot subscription (Go always
                           ranks its published catalog)

github-copilot only:
  --host HOST              github.com or *.ghe.com (or GH_HOST); token from COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN or gh login
  --user LOGIN             Use this gh account's token on the host, ignoring token variables

Scores are benchmarks, not your task; cost is a token estimate, not a bill.
Go ranks at off-peak prices where a model has peak pricing.
Cache: 15 minutes for eligibility, 6 hours for prices, 24 hours for scores (shared with model-frontier).
Exit codes: 0 = results, 1 = error (stderr), 2 = no rankable models.`);
  } else {
    const words = positionals.map(w => w.toLowerCase());
    const planWord = words.filter(w => planWords.includes(w)), commandWord = words.filter(w => commands.includes(w));
    const unknown = words.filter(w => !planWords.includes(w) && !commands.includes(w));
    if (unknown.length || planWord.length > 1 || commandWord.length > 1) throw Error(`Unexpected ${unknown.length ? `"${unknown[0]}"` : 'arguments'}. Usage: model-value [${planWords.join('|')}] [${commands.join('|')}]`);
    const command = commandWord[0] ?? 'value';
    let plan = planWord[0] && planFor(planWord[0]).id;
    if (!plan) plan = await detect(values);
    if (plan !== 'github-copilot') for (const flag of ['host', 'user']) if (values[flag] !== undefined) throw Error(`--${flag} applies to github-copilot only`);
    const query = Object.fromEntries(flags.flatMap(key => {
      const value = values[names[key] ?? key];
      return value === undefined ? [] : [[key, typeof value === 'boolean' || querySchema.properties[key].type === 'string' ? value : value.trim() ? Number(value) : NaN]];
    }));
    if (command !== 'refresh') query.mode = command;
    const mappings = values.mapping ? JSON.parse(await readFile(values.mapping, 'utf8')) : {};
    const modelIds = values.models?.split(',').map(id => id.trim());
    if (modelIds?.some(id => !id)) throw Error('--models cannot contain empty IDs');
    const result = await getRankings(query, { plan, cache: values.cache, host: values.host, user: values.user, offline: values.offline, refresh: command === 'refresh', all: values.all, mappings, modelIds });
    if (result.eligibility?.skippedTokens.length) console.error(`model-value: ${skippedTokenNotice(result.eligibility)}`);
    console.log(values.json ? JSON.stringify(result, null, 2) : format(result, { verbose: values.verbose, style: styleText }));
    if (!result.total) process.exitCode = 2;
  }
} catch (error) {
  console.error(process.argv.includes('--json') ? JSON.stringify({ error: error.message }) : `model-value: ${error.message}`);
  process.exitCode = 1;
}

// One detected plan runs; none or several stop with copy-paste commands. Never guess between them.
async function detect({ host, user }) {
  const found = await detectPlans({ host, user });
  if (found.length === 1) return found[0].plan;
  const list = (found.length ? found : planIds.map(plan => ({ plan }))).map(f => `  model-value ${f.plan}${f.source ? `   (found: ${f.source})` : ''}`).join('\n');
  throw Error(`${found.length ? 'Several plans found' : 'No plan detected'}; name one:\n${list}`);
}
