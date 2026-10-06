import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rank, format, loadSnapshot, options, sources, ttl } from '../src/index.js';
import extension from '../extensions/model-value.js';

delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
// model-frontier caches scores under XDG_CACHE_HOME; keep test runs out of the real cache.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'model-value-xdg-'));
const now = Date.now();
const entry = (slug, score, name = slug) => ({ slug, name, score });
const model = (id, cost = { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 }) => ({ id, cost, limit: { context: 1000000, output: 100000 } });
const fixture = (source = 'arena') => ({ version: 3, plan: 'github-copilot', pricingAt: now, models: [model('alpha'), model('beta', { input: 1, output: 2 })], benchmarks: { source, fetchedAt: now, entries: [entry('alpha', 80), entry('beta', 40)] } });
// OpenCode Go: beta is cheaper in dollars but has a quarter of alpha's monthly limit, so alpha gives more tasks.
const goFixture = () => ({ version: 3, plan: 'opencode-go', pricingAt: now, models: [{ ...model('alpha'), limitUsd: 60, offPeak: false }, { ...model('beta', { input: 1, output: 2 }), limitUsd: 15, offPeak: true }, { ...model('free', { input: 0, output: 0 }), limitUsd: null, offPeak: false }], benchmarks: { source: 'arena', fetchedAt: now, entries: [entry('alpha', 80), entry('beta', 40), entry('free', 30)] } });
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'model-value-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('best sorts by score; value keeps only the price/score frontier, cheapest first', () => {
  const s = fixture();
  s.models.push(model('gamma', { input: 3, output: 12 }), model('delta', { input: 0.5, output: 1 }));
  s.benchmarks.entries.push(entry('gamma', 60), entry('delta', 40));
  assert.deepEqual(rank(s, { mode: 'best' }).models.map(m => m.id), ['alpha', 'gamma', 'delta', 'beta']);
  assert.deepEqual(rank(s, { margin: 0 }).models.map(m => m.id), ['delta', 'alpha']);
  assert.equal(rank(s, { margin: 0 }).dominated, 2);
  assert.equal(rank(s, { mode: 'best' }).dominated, 0);
  assert.match(format(rank(s, { margin: 0 })), /2 more models omitted: each is beaten on price and score/);
  assert.doesNotMatch(format(rank(s, { mode: 'best' })), /omitted/);
  assert.equal(rank(s, { minScore: 70 }).models[0].id, 'alpha');
  for (const result of [rank(s), rank(fixture('aa'), { source: 'aa' })]) {
    assert.match(result.source.attribution, result.source.id === 'aa' ? /Artificial Analysis \(https:\/\/artificialanalysis\.ai\)/ : /CC BY 4\.0 \(https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/\)/);
    assert.ok(format(result).includes(result.source.attribution));
    assert.ok(format(result, { verbose: true }).includes(result.source.attribution));
  }
  const a = rank(s, { input: 100000, cachedInput: 70000, cacheWrite: 10000, output: 10000 }).models[0];
  assert.equal(a.costUsd, 0.179);
  assert.equal(a.aiCredits, 17.9);
  s.models.push(model('aardvark'));
  s.benchmarks.entries.push(entry('aardvark', 80));
  assert.equal(rank(s, { mode: 'best' }).models[0].id, 'aardvark');
  assert.deepEqual(rank(s, { mode: 'best' }).models, rank({ ...s, models: [...s.models].reverse() }, { mode: 'best' }).models);
});

test('styling wraps padded cells, so columns stay aligned; default output has no ANSI', () => {
  const result = rank(fixture());
  const plain = format(result), styled = format(result, { style: (f, t) => `<${f}>${t}</${f}>` });
  assert.match(styled, /^<bold>Best value<\/bold> <dim>· GitHub Copilot · published catalog/);
  assert.equal(styled.replace(/<\/?\w+>/g, ''), plain);
  assert.doesNotMatch(plain, /\x1b/);
});

test('Go value frontier uses the share of each model\'s limit; free models rank at zero', () => {
  const result = rank(goFixture(), { margin: 0 });
  assert.deepEqual(result.models.map(m => [m.id, m.tasksPerMonth]), [['free', null], ['alpha', 200]]);
  assert.equal(result.dominated, 1);
  assert.match(format(result), /^Best value · OpenCode Go · 3 models/);
  assert.match(format(result), /1  free\s+30\s+unlimited\n2  alpha\s+80\s+200/);
  assert.match(format(rank(goFixture(), { mode: 'best' })), /Off-peak prices: beta\. Peak hours cost more\./);
  assert.match(format(result), /Prices and limits: OpenCode Go docs/);
  const unpriced = goFixture();
  unpriced.models[0].cost = { input: 0, output: 0 };
  assert.match(rank(unpriced).skipped[0].reason, /Non-positive/);
});

test('value alternatives: within margin, same price tier, newest in family, at most 3 per row', () => {
  const m = (id, usd, family, date) => ({ id, family, release_date: date, cost: { input: usd * 10, output: 0 } });
  const s = { version: 3, plan: 'github-copilot', pricingAt: now, models: [
    m('cheap', 0.1, 'x', '2026-01-01'), m('cheap-old', 0.1, 'x', '2025-01-01'), m('far', 0.1, 'v', '2026-01-01'),
    m('mid', 0.3, 'y', '2026-01-01'), ...[1, 2, 3, 4].map(i => m(`rival${i}`, 0.3, `r${i}`, '2026-01-01')), m('expensive', 0.9, 'w', '2026-01-01'),
  ], benchmarks: { source: 'arena', fetchedAt: now, entries: [
    entry('cheap', 100), entry('cheap-old', 95), entry('far', 10), entry('mid', 150),
    entry('rival1', 149), entry('rival2', 148), entry('rival3', 147), entry('rival4', 146), entry('expensive', 149),
  ] } };
  const result = rank(s);
  assert.deepEqual(result.models.map(m => [m.id, m.alternativeTo ?? null]), [['cheap', null], ['mid', null], ['rival1', 'mid'], ['rival2', 'mid'], ['rival3', 'mid']]);
  assert.equal(result.total, 2);
  assert.equal(result.dominated, 4);
  assert.deepEqual(rank(s, { margin: 0 }).models.map(m => m.id), ['cheap', 'mid']);
  assert.deepEqual(rank(s, { top: 1 }).models.map(m => m.id), ['cheap']);
  assert.deepEqual(rank(s, { allVersions: true }).models.filter(m => m.alternativeTo === 'cheap').map(m => m.id), ['cheap-old']);
  assert.throws(() => rank(s, { allVersions: 'yes' }), /Invalid allVersions/);
  assert.equal(rank(s, { margin: 5 }).models.length, 5);
  assert.match(format(result), /\n1  cheap +100  \$0\.100\n2  mid +150  \$0\.300\n {5}rival1 +149  \$0\.300\n/);
  assert.throws(() => rank(s, { margin: -1 }), /Invalid margin/);
});

test('a second source can qualify alternatives, with its margin scaled and a per-row tag', () => {
  const m = (id, usd) => ({ id, cost: { input: usd * 10, output: 0 } });
  const models = [m('cheap', 0.1), m('mid', 0.3), m('rival-a', 0.3), m('rival-b', 0.3)];
  const snap = (source, scores) => ({ version: 3, plan: 'github-copilot', pricingAt: now, models, benchmarks: { source, fetchedAt: now, entries: Object.entries(scores).map(([id, score]) => entry(id, score)) } });
  const aa = snap('aa', { cheap: 10, mid: 50, 'rival-a': 30, 'rival-b': 47 });
  const arena = snap('arena', { cheap: 1500, mid: 1700, 'rival-a': 1690, 'rival-b': 1500 });
  const alts = (raw, secondary) => rank(aa, { source: 'aa', ...raw }, { secondary }).models.filter(m => m.alternativeTo).map(m => [m.id, m.closeOn.join('+')]);
  assert.deepEqual(alts({}, arena), [['rival-b', 'aa'], ['rival-a', 'arena']]);
  assert.deepEqual(alts({}), [['rival-b', 'aa']]);
  assert.deepEqual(alts({ margin: 1 }, arena), [['rival-a', 'arena']]);
  assert.deepEqual(alts({ margin: 0.5 }, arena), []);
  const result = rank(aa, { source: 'aa' }, { secondary: arena });
  assert.deepEqual(result.hedge, { source: 'arena', name: 'LMArena WebDev Elo', margin: 50 });
  assert.match(format(result), /\n {5}rival-b +47\.0  \$0\.300  aa\n {5}rival-a +30\.0  \$0\.300  arena\n/);
  assert.equal(rank(aa, { source: 'aa' }).hedge, null);
  assert.doesNotMatch(format(rank(aa, { source: 'aa' })), / aa\n/);
});

test('context tiers use total input and strict threshold, not the legacy 200k alias', () => {
  const s = fixture();
  s.models[0].cost.tiers = [{ tier: { type: 'context', size: 272000 }, input: 4, output: 15, cache_read: 0.4, cache_write: 5 }];
  assert.equal(rank(s, { input: 272000 }).models[0].rates.threshold, null);
  const row = rank(s, { input: 272001, cachedInput: 270000 }).models[0];
  assert.equal(row.rates.threshold, 272000);
  assert.equal(row.costUsd, (2001 * 4 + 270000 * 0.4 + 10000 * 15) / 1e6);
  assert.equal(rank(s, { input: 999999 }).total, 0);
  s.models[0].limit.input = 168000;
  const capped = rank(s, { input: 190000 });
  assert.equal(capped.models.some(m => m.id === 'alpha'), false);
  assert.match(capped.skipped.find(m => m.id === 'alpha').reason, /token limits/);
});

test('arena matching takes the best effort variant but never a different model', () => {
  const s = fixture();
  s.models = ['claude-opus-5', 'gpt-5.4', 'claude-haiku-4.5', 'gpt-5.6-sol', 'gpt-6.1-sol'].map(id => model(id));
  s.benchmarks.entries = [
    entry('claude-opus-5.5-max', 1820), entry('claude-opus-5-high', 1660), entry('claude-opus-5-max', 1694),
    entry('gpt-5.4-mini-high', 1397), entry('gpt-5.4-medium (codex-harness)', 1443),
    entry('claude-haiku-4-5-20251001', 1329), entry('gpt-5.6-sol-xhigh (codex-harness)', 1619), entry('gpt-6-sol-max', 1692),
  ];
  const byId = Object.fromEntries(rank(s, { mode: 'best' }).models.map(m => [m.id, m.benchmark.slug]));
  assert.deepEqual(byId, { 'claude-opus-5': 'claude-opus-5-max', 'gpt-5.4': 'gpt-5.4-medium (codex-harness)', 'claude-haiku-4.5': 'claude-haiku-4-5-20251001', 'gpt-5.6-sol': 'gpt-5.6-sol-xhigh (codex-harness)' });
  assert.match(rank(s).skipped[0].reason, /No arena benchmark match; supply --mapping/);
  assert.equal(rank(s, { mode: 'best' }, { mappings: { 'gpt-6.1-sol': 'gpt-6-sol-max' } }).total, 5);
});

test('aa matching is exact plus deliberate reasoning aliases', () => {
  const s = fixture('aa');
  s.models = [model('alpha-mini'), model('claude-sonnet-4.6')];
  s.benchmarks.entries.push(entry('claude-sonnet-4-6-adaptive', 70, 'Sonnet (Max Effort)'), entry('alpha-mini-high', 90));
  const result = rank(s, { source: 'aa' });
  assert.equal(result.total, 1);
  assert.equal(result.models[0].benchmark.name, 'Sonnet (Max Effort)');
  assert.match(result.skipped[0].reason, /No aa benchmark match/);
  assert.equal(rank(s, { source: 'aa', mode: 'best' }, { mappings: { 'alpha-mini': 'beta' } }).total, 2);
  assert.equal(rank(s, { source: 'aa' }, { modelIds: [] }).total, 0);
  assert.match(rank(s, { source: 'aa' }, { modelIds: ['missing'] }).skipped[0].reason, /No GitHub Copilot pricing/);
});

test('source defaults to aa only when a key is set; mismatched snapshots fail loudly', t => {
  assert.equal(options().source, 'arena');
  process.env.ARTIFICIAL_ANALYSIS_API_KEY = 'k';
  t.after(() => { delete process.env.ARTIFICIAL_ANALYSIS_API_KEY; });
  assert.equal(options().source, 'aa');
  assert.equal(options({ source: 'arena' }).source, 'arena');
  assert.throws(() => rank(fixture('arena')), /Snapshot has arena scores, not aa/);
});

test('bad inputs fail loudly; absent scores/rates are excluded, never invented', () => {
  const s = fixture();
  for (const raw of [{ input: -1 }, { input: NaN }, { top: 0 }, { top: 1.5 }, { mode: 'oops' }, { source: 'oops' }, { sort: 'value' }, { cachedInput: 100001 }, { output: Infinity }, { input: 0, output: 0 }, { minScore: null }]) assert.throws(() => rank(s, raw));
  assert.equal(rank(s, { cachedInput: 10 }).skipped[0].id, 'beta');
  s.benchmarks.entries[0].score = null;
  assert.equal(rank(s).models[0].id, 'beta');
  assert.match(rank(s).skipped[0].reason, /No arena score/);
  s.models[0].cost.input = '2';
  assert.throws(() => rank(s), /Invalid alpha.input/);
});

test('arena refresh pages without a key; offline reuses it; other sources and old caches are not reused', async t => {
  const dir = await temp(t), cache = join(dir, 'cache.json');
  const s = fixture();
  const fetches = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    fetches.push(url);
    if (url === sources.pricing) return new Response(JSON.stringify({ 'github-copilot': { models: Object.fromEntries(s.models.map(m => [m.id, m])) } }));
    assert.equal(init.headers, undefined);
    const offset = Number(new URL(url).searchParams.get('offset'));
    const rows = offset === 0
      ? Array.from({ length: 100 }, (_, i) => ({ row: { model_name: `filler-${i}`, rating: 1000, category: 'overall' } }))
      : [{ row: { model_name: 'alpha-max', rating: 1700, category: 'overall' } }, { row: { model_name: 'alpha-max', rating: 1900, category: 'css' } }];
    return new Response(JSON.stringify({ rows, num_rows_total: 102 }));
  });
  await writeFile(cache, JSON.stringify({ version: 1, models: [] }));
  const fresh = await loadSnapshot({ cache, source: 'arena' });
  // models.dev twice: Copilot prices here, reference prices inside model-frontier.
  assert.equal(fetches.length, 4);
  assert.equal(fresh.benchmarks.entries.length, 101);
  assert.equal(rank(fresh).models[0].benchmark.name, 'alpha-max');
  assert.deepEqual(await loadSnapshot({ cache, source: 'arena', offline: true }), fresh);
  await assert.rejects(loadSnapshot({ cache, source: 'aa', offline: true }), /No offline aa snapshot/);
  assert.equal(await loadSnapshot({ cache, source: 'aa', offline: true, optional: true }), undefined);
  await assert.rejects(loadSnapshot({ cache, source: 'aa', refresh: true }), /needs ARTIFICIAL_ANALYSIS_API_KEY/);
  assert.equal(fetches.length, 4);
  const stale = { ...fresh, pricingAt: now - ttl - 1000 };
  await writeFile(cache, JSON.stringify(stale));
  assert.equal(rank(await loadSnapshot({ cache, source: 'arena', offline: true })).stale, true);
  assert.deepEqual(JSON.parse(await readFile(cache, 'utf8')), stale);
});

test('aa refresh sends the key and scores by intelligence index', async t => {
  const dir = await temp(t), cache = join(dir, 'cache.json');
  process.env.ARTIFICIAL_ANALYSIS_API_KEY = 'secret-key';
  t.after(() => { delete process.env.ARTIFICIAL_ANALYSIS_API_KEY; });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === sources.pricing) return new Response(JSON.stringify({ 'github-copilot': { models: { alpha: model('alpha') } } }));
    assert.equal(init.headers['x-api-key'], 'secret-key');
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ data: [{ slug: 'alpha', name: 'Alpha (max)', evaluations: { artificial_analysis_intelligence_index: 55, artificial_analysis_coding_index: null } }], pagination: { has_more: false } }));
  });
  const result = rank(await loadSnapshot({ cache }));
  assert.equal(result.source.id, 'aa');
  assert.equal(result.models[0].score, 55);
  assert(!(await readFile(cache, 'utf8')).includes('secret-key'));
});

test('CLI pretty, JSON, failure and empty-result exits work as subprocesses', async t => {
  const dir = await temp(t), cache = join(dir, 'snapshot.json');
  await writeFile(cache, JSON.stringify(fixture()));
  const run = (...args) => spawnSync(process.execPath, [cli, 'copilot', ...args, '--cache', cache, '--offline', '--all'], { encoding: 'utf8' });
  const pretty = run('best');
  assert.equal(pretty.status, 0, pretty.stderr);
  assert.match(pretty.stdout, /^Best models · GitHub Copilot · published catalog · LMArena WebDev Elo\n\n#  MODEL  SCORE    COST\n1  alpha     80  \$0.300\n/);
  assert.doesNotMatch(pretty.stdout, /CREDITS|Benchmark variants|Z ·/);
  const narrowed = run('--models', 'alpha,missing', '--min-score', '50');
  assert.match(narrowed.stdout, /Not ranked: missing \(--verbose for reasons\)/);
  const verbose = run('--verbose');
  assert.match(verbose.stdout, /MODEL\s+SCORE\s+USD\s+CREDITS/);
  assert.match(verbose.stdout, /Benchmark variants:/);
  const json = run('--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).models.map(m => m.dispatchId), ['github-copilot/beta', 'github-copilot/alpha']);
  assert.equal(run('--json', '--models', 'missing').status, 2);
  assert.equal(JSON.parse(run('--json', '--all-versions').stdout).options.allVersions, true);
  assert.equal(run('--source', 'aa').status, 1);
  const invalid = run('--input=-1', '--json');
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /Invalid input/);
  assert.match(run('rank').stderr, /Unexpected "rank"/);
  // A snapshot of another plan is never reused for this one.
  assert.match(spawnSync(process.execPath, [cli, 'opencode-go', '--cache', cache, '--offline'], { encoding: 'utf8' }).stderr, /No offline arena snapshot/);
  assert.match(spawnSync(process.execPath, [cli, 'opencode-go', '--host', 'x.ghe.com'], { encoding: 'utf8' }).stderr, /--host applies to github-copilot only/);
});

test('help works without credentials and its ranking examples execute against a snapshot', async t => {
  const dir = await temp(t);
  const caches = { copilot: join(dir, 'copilot.json'), go: join(dir, 'go.json') };
  await writeFile(caches.copilot, JSON.stringify(fixture()));
  await writeFile(caches.go, JSON.stringify(goFixture()));
  // No gh, no OpenCode key: detection finds nothing, so a bare example must name its plan to run.
  const env = { ...process.env, PATH: '', HOME: dir, XDG_DATA_HOME: dir, PI_CODING_AGENT_DIR: dir, OPENCODE_API_KEY: '', COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
  const help = spawnSync(process.execPath, [cli, '--help', '--cache', join(dir, 'missing-cache.json')], { encoding: 'utf8', env });
  assert.equal(help.status, 0, help.stderr);
  const examples = [...help.stdout.matchAll(/^    model-value(.*)$/gm)].map(match => match[1].trim());
  assert(examples.includes('') && examples.includes('opencode-go-plus best'));
  for (const example of examples) {
    const args = example.split(/\s+/).filter(Boolean);
    if (!args.length) {
      const bare = spawnSync(process.execPath, [cli], { encoding: 'utf8', env });
      assert.match(bare.stderr, /No plan detected; name one:\n  model-value github-copilot\n  model-value opencode-go\n  model-value opencode-go-plus/);
      continue;
    }
    const go = args[0].startsWith('opencode-go');
    const result = spawnSync(process.execPath, [cli, ...args, '--cache', go ? caches.go : caches.copilot, '--offline', ...(go ? [] : ['--all'])], { encoding: 'utf8', env });
    // The Go fixture is plan opencode-go; the Go Plus example must refuse to reuse it offline.
    if (args[0] === 'opencode-go-plus') { assert.match(result.stderr, /No offline arena snapshot/); continue; }
    assert([0, 2].includes(result.status), `${example}: ${result.stderr}`);
    if (example.includes('--json')) assert(Array.isArray(JSON.parse(result.stdout).models));
  }
});

test('pi tool ranks only authenticated Copilot models; command requires selection and consent', async t => {
  const dir = await temp(t), cache = join(dir, 'snapshot.json');
  await writeFile(cache, JSON.stringify(fixture()));
  // Every non-pi credential source is poisoned: using any of them fails the request assertions or throws.
  const poisoned = { MODEL_VALUE_CACHE: cache, COPILOT_GITHUB_TOKEN: 'github_pat_not_pi', GH_TOKEN: 'gho_not_pi', GITHUB_TOKEN: 'gho_not_pi', GH_HOST: 'not-a-copilot-host.example', PATH: '' };
  const saved = Object.fromEntries(Object.keys(poisoned).map(name => [name, process.env[name]]));
  Object.assign(process.env, poisoned);
  t.after(() => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value; });
  const requests = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
    requests.push([String(url), headers.Authorization]);
    return new Response(status === 200 ? JSON.stringify({ data: [{ id: 'alpha', model_picker_enabled: true, policy: { state: 'enabled' } }] }) : 'bad token', { status });
  });
  let tool, command, selectedModel, confirm = false;
  extension({ registerTool: t => { tool = t; }, registerCommand: (_, c) => { command = c; }, setModel: async m => { selectedModel = m; return true; }, getThinkingLevel: () => 'high' });
  const alpha = { provider: 'github-copilot', id: 'alpha' };
  const login = { ok: true, apiKey: 'tid=pi', baseUrl: 'https://api.business.githubcopilot.com' };
  let auth = login;
  const ctx = { hasUI: true, waitForIdle: async () => {}, modelRegistry: { getAvailable: () => [alpha, { provider: 'other', id: 'beta' }], find: () => alpha, getApiKeyAndHeaders: async () => auth }, ui: { select: async (_, rows) => rows[0], confirm: async () => confirm, notify: () => {} } };
  const run = params => tool.execute('test', params, undefined, undefined, ctx);
  const piRequest = ['https://api.business.githubcopilot.com/models', 'Bearer tid=pi'];
  const result = await run({ mode: 'value' });
  assert.equal(result.details.total, 1);
  assert.equal(result.details.models[0].id, 'alpha');
  assert.equal(result.details.eligibility.tokenSource, 'pi login');
  assert.deepEqual(requests, [piRequest]);
  assert.ok(JSON.parse(await readFile(`${cache}.eligibility-pi-login.json`, 'utf8')).modelIds.includes('alpha'));
  await assert.rejects(readFile(`${cache}.eligibility.json`), { code: 'ENOENT' });
  assert.equal(selectedModel, undefined);
  await assert.rejects(run({ offline: true }), /offline needs all=true/);
  assert.equal((await run({ all: true, offline: true })).details.scope, 'published-catalog');
  auth = { ok: false, error: 'No API key found for "github-copilot"' };
  await assert.rejects(run({}), /pi Copilot login: No API key/);
  auth = { ok: true, apiKey: 'tid=pi' };
  await assert.rejects(run({}), /no Copilot token or endpoint/);
  auth = { ...login, apiKey: 'tid=rotated' };
  status = 401;
  await assert.rejects(run({}), /Token from pi login rejected; run \/login in pi/);
  auth = login;
  status = 200;
  await rm(`${cache}.eligibility-pi-login.json`);
  requests.length = 0;
  await command.handler('best', ctx);
  assert.deepEqual(requests, [piRequest]);
  assert.equal(selectedModel, undefined);
  confirm = true;
  await command.handler('', ctx);
  assert.equal(selectedModel, alpha);
  await assert.rejects(command.handler('best', { ...ctx, hasUI: false }), /requires interactive/);
});
