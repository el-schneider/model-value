import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { loadModels, frontier, sources as frontierSources } from 'model-frontier';
import { plans, planFor } from './plans.js';
import { parseGoDocs, docsSource as goDocs, docsPage as goPage } from './opencode-go.js';

export const sources = {
  pricing: 'https://models.dev/api.json',
  aa: frontierSources.aa.api,
  arena: frontierSources.arena.api,
  authoritativePricing: 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing',
  opencodeGo: goDocs,
};
export const benchmarkSources = {
  aa: { margin: 5, name: 'Artificial Analysis Intelligence Index', url: 'https://artificialanalysis.ai', caveat: 'AA scores the exact variant shown; scores do not measure pi task success or Copilot speed.' },
  arena: { margin: 50, name: 'LMArena WebDev Elo', url: 'https://lmarena.ai/leaderboard/webdev', caveat: 'Arena Elo is human preference on web-app tasks (lmarena-ai/leaderboard-dataset, CC BY 4.0). The best-scoring effort variant is used.' },
};
// Every output names its score source and price source; LMArena data is CC BY 4.0 and needs the license link.
const modelsDevPrices = ' · Prices: models.dev (https://models.dev)';
const attribution = (source, plan) => `${frontierSources[source].attribution.replace(modelsDevPrices, '')}${plans[plan].perModelLimit ? ` · Prices and limits: OpenCode Go docs (${goPage})` : modelsDevPrices}`;
export const ttl = 6 * 60 * 60 * 1000;
export const defaultSource = () => process.env.ARTIFICIAL_ANALYSIS_API_KEY ? 'aa' : 'arena';
export const cacheDir = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'model-value');
// MODEL_VALUE_CACHE is one exact file, like --cache: a snapshot for another plan or source is refetched, not mixed in.
export const defaultCache = (plan, source = defaultSource()) => process.env.MODEL_VALUE_CACHE ?? join(cacheDir(), `snapshot-${plan}-${source}.json`);
const normalize = (id) => id.toLowerCase().replace(/[._]/g, '-');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const aliases = {
  'claude-sonnet-4.6': 'claude-sonnet-4-6-adaptive',
  'claude-sonnet-4': 'claude-4-sonnet-thinking',
  'claude-opus-4.6': 'claude-opus-4-6-adaptive',
  'claude-haiku-4.5': 'claude-4-5-haiku-reasoning',
};
// Arena lists effort/date/harness variants of one model; anything else after the ID (e.g. "-5-max", "-mini") is a different model.
const arenaVariant = /^(-(minimal|low|medium|high|xhigh|max|thinking|\d{8}))*( \([^)]*\))?$/;

export const querySchema = {
  type: 'object', additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['value', 'best'], default: 'value', description: 'value: price/score frontier, cheapest first. best: highest score first' },
    source: { type: 'string', enum: ['aa', 'arena'], description: 'Default: aa when ARTIFICIAL_ANALYSIS_API_KEY is set, else arena (no key needed)' },
    minScore: { type: 'number', minimum: 0, description: 'Uses the source scale: AA index ~0-70, Arena Elo ~1300-1850' },
    margin: { type: 'number', minimum: 0, description: 'value mode: show close alternatives within this many score points of a frontier model. Default 5 (aa) or 50 (arena); 0 = strict frontier' },
    allVersions: { type: 'boolean', default: false, description: 'value mode: also show older models of a family whose newer model is listed' },
    input: { type: 'integer', minimum: 0, description: 'Total input tokens, including cache reads and writes', default: 100000 },
    cachedInput: { type: 'integer', minimum: 0, default: 0 },
    cacheWrite: { type: 'integer', minimum: 0, default: 0 },
    output: { type: 'integer', minimum: 0, default: 10000 },
    top: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
  },
};

function number(value, label, integer = false) {
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw Error(`Invalid ${label}: expected non-negative ${integer ? 'integer' : 'number'}`);
  return value;
}
function text(value, label) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value)) throw Error(`Invalid ${label}`);
  return value;
}
export function options(raw = {}) {
  for (const key of Object.keys(raw)) if (!(key in querySchema.properties)) throw Error(`Unknown ranking option: ${key}`);
  const o = { mode: 'value', source: defaultSource(), minScore: 0, allVersions: false, input: 100000, cachedInput: 0, cacheWrite: 0, output: 10000, top: 10, ...raw };
  for (const key of ['mode', 'source']) if (!querySchema.properties[key].enum.includes(o[key])) throw Error(`Invalid ${key}: ${o[key]}`);
  for (const key of ['input', 'cachedInput', 'cacheWrite', 'output', 'top']) number(o[key], key, true);
  number(o.minScore, 'minScore');
  if (typeof o.allVersions !== 'boolean') throw Error('Invalid allVersions: expected boolean');
  o.margin = number(o.margin ?? benchmarkSources[o.source].margin, 'margin');
  if (!o.top || o.top > 100) throw Error('top must be 1–100');
  if (o.cachedInput + o.cacheWrite > o.input) throw Error('cachedInput + cacheWrite must not exceed total input');
  if (!o.input && !o.output) throw Error('Workload must contain tokens');
  return o;
}

function validateRates(rates, label) {
  if (!rates || typeof rates !== 'object') throw Error(`Missing pricing: ${label}`);
  number(rates.input, `${label}.input`);
  number(rates.output, `${label}.output`);
  for (const key of ['cache_read', 'cache_write']) if (rates[key] !== undefined) number(rates[key], `${label}.${key}`);
}
export function validateSnapshot(s) {
  const b = s?.benchmarks;
  if (s?.version !== 3 || !(s.plan in plans) || !Array.isArray(s.models) || !s.models.length || !(b?.source in benchmarkSources) || !Array.isArray(b.entries) || !b.entries.length) throw Error('Invalid snapshot format');
  for (const [key, value] of [['pricingAt', s.pricingAt], ['benchmarks.fetchedAt', b.fetchedAt]]) {
    number(value, key);
    if (!value || value > Date.now() + 60000) throw Error(`Invalid ${key}`);
  }
  const ids = new Set();
  for (const m of s.models) {
    text(m.id, 'model id');
    if (ids.has(m.id)) throw Error(`Duplicate model: ${m.id}`);
    ids.add(m.id);
    validateRates(m.cost, m.id);
    if (m.cost.tiers !== undefined && !Array.isArray(m.cost.tiers)) throw Error(`Invalid tiers: ${m.id}`);
    for (const t of m.cost.tiers ?? []) {
      if (t.tier?.type !== 'context') throw Error(`Unsupported pricing tier: ${m.id}`);
      number(t.tier.size, `${m.id}.threshold`, true);
      validateRates(t, m.id);
    }
    if (m.limit?.input !== undefined) number(m.limit.input, `${m.id}.input limit`, true);
    if (m.limit?.context !== undefined) number(m.limit.context, `${m.id}.context`, true);
    if (m.limit?.output !== undefined) number(m.limit.output, `${m.id}.output limit`, true);
    // null = unlimited (documented free models); JSON cannot carry Infinity.
    if (plans[s.plan].perModelLimit && m.limitUsd !== null && !(number(m.limitUsd, `${m.id}.limitUsd`) > 0)) throw Error(`Invalid monthly limit: ${m.id}`);
  }
  const slugs = new Set();
  for (const e of b.entries) {
    text(e.slug, `${b.source} slug`); text(e.name, `${b.source} name`);
    if (e.score !== null) number(e.score, `${e.slug}.score`);
    if (b.source === 'aa' && slugs.has(normalize(e.slug))) throw Error(`Ambiguous AA slug: ${e.slug}`);
    slugs.add(normalize(e.slug));
  }
  return s;
}

async function readOptional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function fetchOk(url, signal) {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`${url}: HTTP ${response.status}`);
  return response;
}
const fetchJson = async (url, signal) => (await fetchOk(url, signal)).json();

// Copilot: models.dev has the prices. OpenCode Go: its docs are the billing source for prices and limits;
// models.dev only adds metadata (token limits, family, release date) where it knows the model.
async function planModels(plan, signal) {
  const [catalog, docs] = await Promise.all([fetchJson(sources.pricing, signal), plans[plan].perModelLimit ? fetchOk(goDocs, signal).then(r => r.text()) : undefined]);
  const known = catalog[plans[plan].provider]?.models;
  if (!docs) {
    if (!known || typeof known !== 'object' || Array.isArray(known)) throw Error(`models.dev has no ${plans[plan].label} catalog`);
    return Object.values(known);
  }
  return parseGoDocs(docs)[plan].map(m => ({ ...known?.[m.id], ...m }));
}
// model-frontier fetches and caches the scores; its cache is shared with the model-frontier CLI.
async function fetchScores(source, refresh, signal) {
  const { models } = await loadModels({ source, refresh, signal });
  return models.map(m => ({ slug: m.id, name: m.name, score: source === 'aa' ? m.scores.intelligence : m.scores.arena }));
}
export async function loadSnapshot({ plan = 'github-copilot', source = defaultSource(), cache = defaultCache(plan, source), offline = false, refresh = false, optional = false, signal } = {}) {
  if (offline && refresh) throw Error('offline and refresh cannot be combined');
  if (!(source in benchmarkSources)) throw Error(`Invalid source: ${source}`);
  planFor(plan);
  let existing = refresh ? undefined : await readOptional(cache);
  if (existing?.version !== 3) existing = undefined;
  else if (validateSnapshot(existing).benchmarks.source !== source || existing.plan !== plan) existing = undefined;
  if (existing && (offline || Date.now() - Math.min(existing.pricingAt, existing.benchmarks.fetchedAt) < ttl)) return existing;
  if (offline && optional) return undefined;
  if (offline) throw Error(`No offline ${source} snapshot at ${cache}; run model-value ${plan} refresh first`);
  if (source === 'aa' && !process.env.ARTIFICIAL_ANALYSIS_API_KEY) throw Error('Source aa needs ARTIFICIAL_ANALYSIS_API_KEY (free at https://artificialanalysis.ai/data-api); omit --source to use LMArena without a key');
  const [models, entries] = await Promise.all([planModels(plan, signal), fetchScores(source, refresh, signal)]);
  const snapshot = validateSnapshot({ version: 3, plan, pricingAt: Date.now(), models, benchmarks: { source, fetchedAt: Date.now(), entries } });
  await mkdir(dirname(cache), { recursive: true });
  const temp = `${cache}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(temp, cache);
  return snapshot;
}

function match(entries, source, id, mapped) {
  const target = normalize(mapped ?? (source === 'aa' ? aliases[id] ?? id : id));
  const hits = entries.filter(e => {
    const n = normalize(e.slug);
    return mapped || source === 'aa' ? n === target : n.startsWith(target) && arenaVariant.test(n.slice(target.length));
  });
  return hits.filter(e => e.score !== null).sort((a, b) => b.score - a.score)[0] ?? hits[0];
}

// For one source's scores, how far each model sits below the best score available at its price or less.
function gapsFor(rows, score) {
  const front = frontier(rows.filter(r => score.has(r.id)), { score: r => score.get(r.id), cost: r => r.rankingCost });
  return m => {
    const parent = score.has(m.id) && front.findLast(f => f.rankingCost <= m.rankingCost);
    return parent ? score.get(parent.id) - score.get(m.id) : Infinity;
  };
}

// Scores are noisy, prices are not: a model just below the frontier on any source may be as good in practice.
// Alternatives stay in their frontier row's price tier, and an older model is dropped when a newer one of its family is listed.
function alternativesFor(rows, frontier, catalog, sources, allVersions) {
  const onFrontier = new Set(frontier.map(m => m.id));
  const tests = sources.map(t => ({ ...t, gap: gapsFor(rows, t.score) }));
  const candidates = rows.filter(m => !onFrontier.has(m.id)).flatMap(m => {
    const i = frontier.findLastIndex(f => f.rankingCost <= m.rankingCost);
    const parent = frontier[i], next = frontier[i + 1];
    const closeOn = tests.filter(t => t.gap(m) <= t.margin).map(t => t.source);
    return closeOn.length && (next ? m.rankingCost < next.rankingCost : m.rankingCost <= parent.rankingCost)
      ? [{ ...m, alternativeTo: parent.id, closeOn, gap: parent.score - m.score }] : [];
  });
  const listed = [...frontier, ...candidates].map(m => catalog.get(m.id));
  const superseded = m => !allVersions && listed.some(o => o.family && o.family === m.family && o.release_date > m.release_date);
  const shown = [];
  for (const c of candidates.sort((a, b) => a.gap - b.gap || a.rankingCost - b.rankingCost || compare(a.id, b.id)))
    if (!superseded(catalog.get(c.id)) && shown.filter(s => s.alternativeTo === c.alternativeTo).length < 3) shown.push(c);
  return shown.map(({ gap, ...m }) => m);
}

export function rank(snapshot, raw = {}, { modelIds, mappings = {}, secondary } = {}) {
  validateSnapshot(snapshot);
  const plan = plans[snapshot.plan];
  const o = options(raw);
  const { source, entries } = snapshot.benchmarks;
  if (source !== o.source) throw Error(`Snapshot has ${source} scores, not ${o.source}`);
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) throw Error('Mappings must be an object of model ID to exact benchmark slug');
  for (const [id, slug] of Object.entries(mappings)) { text(id, 'mapping id'); text(slug, 'mapping slug'); }
  if (modelIds !== undefined && (!Array.isArray(modelIds) || modelIds.some(id => typeof id !== 'string'))) throw Error('modelIds must be an array of IDs');
  const allowed = modelIds && new Set(modelIds.map(id => id.startsWith(`${plan.provider}/`) ? id.slice(plan.provider.length + 1) : id));
  const skipped = [], rows = [];
  for (const m of snapshot.models) {
    if (allowed && !allowed.has(m.id)) continue;
    const reject = reason => skipped.push({ id: m.id, reason });
    const found = match(entries, source, m.id, mappings[m.id]);
    if (!found) { reject(`No ${source} benchmark match${mappings[m.id] ? ` for mapping ${mappings[m.id]}` : '; supply --mapping'}`); continue; }
    const score = found.score;
    if (score === null) { reject(`No ${source} score for ${found.name}`); continue; }
    if (score < o.minScore) { reject(`Below minimum score ${o.minScore}`); continue; }
    if ((m.limit?.input && o.input > m.limit.input) || (m.limit?.context && o.input + o.output > m.limit.context) || (m.limit?.output && o.output > m.limit.output)) { reject('Workload exceeds model token limits'); continue; }
    let rates = m.cost, threshold = null;
    const tiers = [...(m.cost.tiers ?? [])].sort((a, b) => a.tier.size - b.tier.size);
    if (!tiers.length && m.cost.context_over_200k) { reject('Legacy long-context pricing has no exact threshold'); continue; }
    for (const tier of tiers) if (o.input > tier.tier.size) { rates = tier; threshold = tier.tier.size; }
    if (o.cachedInput && rates.cache_read === undefined) { reject('Missing cache-read rate'); continue; }
    if (o.cacheWrite && rates.cache_write === undefined) { reject('Missing cache-write rate'); continue; }
    const costUsd = ((o.input - o.cachedInput - o.cacheWrite) * rates.input + o.cachedInput * (rates.cache_read ?? 0) + o.cacheWrite * (rates.cache_write ?? 0) + o.output * rates.output) / 1e6;
    // Zero cost is only real for a model documented as free with an unlimited allowance; anywhere else it means missing prices.
    const free = plan.perModelLimit && m.limitUsd === null;
    if (!Number.isFinite(costUsd) || costUsd < 0 || (costUsd === 0 && !free)) { reject('Non-positive or invalid workload cost'); continue; }
    if (free && costUsd > 0) { reject('Unlimited allowance but non-zero price'); continue; }
    // rankingCost is what the frontier compares: Copilot cost in USD; Go the share of the monthly allowance one task uses.
    const billing = plan.perModelLimit
      ? { rankingCost: free ? 0 : costUsd / m.limitUsd, limitUsd: m.limitUsd, tasksPerMonth: free ? null : m.limitUsd / costUsd, unlimited: free, offPeak: m.offPeak }
      : { rankingCost: costUsd, aiCredits: costUsd * 100 };
    rows.push({ id: m.id, dispatchId: `${plan.provider}/${m.id}`, benchmark: { slug: found.slug, name: found.name }, score, costUsd, ...billing, rates: { input: rates.input, output: rates.output, cacheRead: rates.cache_read ?? null, cacheWrite: rates.cache_write ?? null, threshold } });
  }
  if (allowed) for (const id of allowed) if (!snapshot.models.some(m => m.id === id)) skipped.push({ id, reason: `No ${plan.label} pricing in catalog` });
  let front = rows, models, hedge;
  if (o.mode === 'best') {
    rows.sort((a, b) => b.score - a.score || a.rankingCost - b.rankingCost || compare(a.id, b.id));
    models = rows.slice(0, o.top);
  } else {
    rows.sort((a, b) => a.rankingCost - b.rankingCost || b.score - a.score || compare(a.id, b.id));
    front = frontier(rows, { score: r => r.score, cost: r => r.rankingCost });
    if (secondary) {
      validateSnapshot(secondary);
      const { source: id, entries: other } = secondary.benchmarks;
      const score = new Map(rows.flatMap(r => { const e = match(other, id, r.id); return e?.score != null ? [[r.id, e.score]] : []; }));
      hedge = { source: id, margin: benchmarkSources[id].margin * o.margin / benchmarkSources[source].margin, score };
    }
    const tests = [{ source, margin: o.margin, score: new Map(rows.map(r => [r.id, r.score])) }, ...(hedge ? [hedge] : [])];
    const alternatives = o.margin ? alternativesFor(rows, front, new Map(snapshot.models.map(m => [m.id, m])), tests, o.allVersions) : [];
    models = front.slice(0, o.top).flatMap(f => [f, ...alternatives.filter(a => a.alternativeTo === f.id)]);
  }
  skipped.sort((a, b) => compare(a.id, b.id));
  return {
    snapshotId: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    plan: { id: plan.id, label: plan.label, provider: plan.provider },
    sources, source: { id: source, ...benchmarkSources[source], attribution: attribution(source, plan.id) },
    pricingAt: snapshot.pricingAt, benchmarksAt: snapshot.benchmarks.fetchedAt,
    stale: Date.now() - Math.min(snapshot.pricingAt, snapshot.benchmarks.fetchedAt) >= ttl,
    options: o, scope: allowed ? 'explicit-model-list' : 'published-catalog',
    caveats: [
      'Catalog membership is not account entitlement.',
      ...(plan.perModelLimit ? [
        `Prices and monthly limits from ${goPage} (source ${goDocs}). Models with peak pricing are ranked at off-peak prices; peak hours cost more.`,
        'tasksPerMonth = monthly limit / cost per task, if you used only that model. All models draw on one allowance; each model\'s spend counts against it in proportion to its limit. Not remaining quota.',
      ] : ['Token-billed AI Credits only; not legacy premium-request plans.']),
      benchmarkSources[source].caveat,
      ...(o.mode === 'value' ? [`Value lists the price/score frontier: each row ${plan.perModelLimit ? 'uses more of the allowance' : 'costs more'} and scores higher than the previous one; every omitted model is beaten on both. Alternatives score within ${o.margin} of a frontier model${hedge ? ` (or within ${hedge.margin} on ${benchmarkSources[hedge.source].name})` : ''} in the same price tier.`] : []),
    ],
    total: front.length, catalogSize: snapshot.models.length, models, skipped,
    hedge: hedge ? { source: hedge.source, name: benchmarkSources[hedge.source].name, margin: hedge.margin } : null,
    dominated: o.mode === 'value' ? rows.length - front.length - models.filter(m => m.alternativeTo).length : 0,
  };
}

const tasks = m => m.unlimited ? 'unlimited' : Math.floor(m.tasksPerMonth).toLocaleString('en-US');
// The one plan-specific number per row: Copilot bills dollars from one pool; Go limits each model's share.
const billingColumns = (result, verbose) => result.plan.id === 'github-copilot'
  ? verbose ? [['USD', m => m.costUsd.toFixed(4)], ['CREDITS', m => m.aiCredits.toFixed(2)]] : [['COST', m => `$${m.costUsd.toFixed(3)}`]]
  : verbose ? [['USD', m => m.costUsd.toFixed(4)], ['LIMIT', m => m.unlimited ? 'unlimited' : `$${m.limitUsd}`], ['TASKS/MO', tasks]] : [['TASKS/MO', tasks]];

function formatVerbose(result) {
  const o = result.options;
  const lines = [
    `${result.plan.label} ${o.mode === 'value' ? 'value frontier (cheapest first)' : 'best models'} · ${result.source.name}`,
    `Input ${o.input} (cached ${o.cachedInput}, write ${o.cacheWrite}) · output ${o.output}`,
    `Prices ${new Date(result.pricingAt).toISOString()} · Scores ${new Date(result.benchmarksAt).toISOString()}${result.stale ? ' · STALE SNAPSHOT' : ''}`,
    result.eligibility
      ? `Subscription: ${result.eligibility.enabledCount} enabled · checked ${new Date(result.eligibility.fetchedAt).toISOString()}${result.eligibility.stale ? ' · STALE ELIGIBILITY' : ''}`
      : 'Scope: published catalog (account eligibility not checked)',
    '',
  ];
  const columns = billingColumns(result, true);
  const rows = [['#', 'MODEL', 'SCORE', ...columns.map(c => c[0])], ...numbered(result.models).map(([n, m]) => [n, m.alternativeTo ? `  ${m.id}` : m.id, m.score.toFixed(1), ...columns.map(c => c[1](m))])];
  const widths = rows[0].map((_, col) => Math.max(...rows.map(row => row[col].length)));
  lines.push(...rows.map(row => row.map((cell, col) => col < 2 ? cell.padEnd(widths[col]) : cell.padStart(widths[col])).join('  ').trimEnd()));
  if (!result.models.length) lines.push('No rankable models.');
  lines.push('', 'Benchmark variants:', ...result.models.map(m => `  ${m.id}: ${m.benchmark.name}`));
  if (result.skipped.length) lines.push('', `Excluded (${result.skipped.length}):`, ...result.skipped.map(m => `  ${m.id}: ${m.reason}`));
  lines.push('', ...result.caveats, result.source.attribution);
  return lines.join('\n');
}

const k = n => `${n / 1000}k`;
const numbered = models => { let n = 0; return models.map(m => [m.alternativeTo ? '' : String(++n), m]); };
// style defaults to plain text so tool/JSON consumers never get ANSI codes; the CLI passes util.styleText.
export function format(result, { verbose = false, style = (_, text) => text } = {}) {
  if (verbose) return formatVerbose(result);
  const o = result.options, plan = result.plan, go = plan.id !== 'github-copilot';
  const scope = result.eligibility ? `${result.eligibility.enabledCount} models on your plan` : go ? `${result.catalogSize} models` : 'published catalog';
  const lines = [`${style('bold', o.mode === 'value' ? 'Best value' : 'Best models')} ${style('dim', `· ${plan.label} · ${scope} · ${result.source.name}`)}`];
  if (o.mode === 'value') lines.push(style('dim', `Each numbered row scores higher and ${go ? 'gets fewer tasks per month' : 'costs more'} than the one above. Indented: alternatives within ${o.margin} points${result.hedge ? ` (or ${result.hedge.margin} on ${result.hedge.name})` : ''} in the same price tier.`));
  if (result.stale || result.eligibility?.stale) lines.push(style('yellow', `STALE cached data; run model-value ${plan.id} refresh`));
  const [[label, cell]] = billingColumns(result, false);
  const rows = [['#', 'MODEL', 'SCORE', label, ''], ...numbered(result.models).map(([n, m]) => [n, m.alternativeTo ? `  ${m.id}` : m.id, m.score.toFixed(result.source.id === 'aa' ? 1 : 0), cell(m), result.hedge ? m.closeOn?.join('+') ?? '' : ''])];
  const widths = rows[0].map((_, col) => Math.max(...rows.map(row => row[col].length)));
  const table = rows.map(row => row.map((cell, col) => col < 2 || col === 4 ? cell.padEnd(widths[col]) : cell.padStart(widths[col])));
  lines.push('', style('dim', table[0].join('  ').trimEnd()), ...table.slice(1).map(([rank, ...rest], i) => result.models[i].alternativeTo
    ? style('dim', `${rank}  ${rest.join('  ')}`.trimEnd())
    : `${style('dim', rank)}  ${rest.join('  ')}`.trimEnd()));
  if (!result.models.length) lines.push('No rankable models.');
  const cache = [o.cachedInput && `${k(o.cachedInput)} cached`, o.cacheWrite && `${k(o.cacheWrite)} cache write`].filter(Boolean).join(', ');
  const task = `${k(o.input)} input${cache ? ` (${cache})` : ''}, ${k(o.output)} output`;
  const footer = [go ? `Task: ${task}. Tasks/mo: the model's monthly limit ÷ cost per task, if you used only that model.` : `Cost per task: ${task}.`];
  const offPeak = result.models.filter(m => m.offPeak).map(m => m.id);
  if (offPeak.length) footer.push(`Off-peak prices: ${offPeak.join(', ')}. Peak hours cost more.`);
  if (result.dominated) footer.push(`${result.dominated} more models omitted: each is beaten on ${go ? 'tasks per month' : 'price'} and score by a listed model (model-value ${plan.id} best lists all).`);
  const unranked = result.skipped.filter(m => !m.reason.startsWith('Below minimum')).map(m => m.id);
  if (unranked.length) footer.push(`Not ranked: ${unranked.join(', ')} (--verbose for reasons).`);
  footer.push(result.source.attribution);
  lines.push('', ...footer.map(line => style('dim', line)));
  return lines.join('\n');
}
