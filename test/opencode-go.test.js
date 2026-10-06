import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGoDocs } from '../src/opencode-go.js';
import { findGoKey } from '../src/opencode-auth.js';
import { rank, format, validateSnapshot } from '../src/index.js';

delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
const docs = await readFile(new URL('./fixtures/go.mdx', import.meta.url), 'utf8');
const now = Date.now();

test('parses both Go tiers from the docs source: limits, tiers, off-peak, unlimited', () => {
  const plans = parseGoDocs(docs);
  const get = (plan, id) => plans[plan].find(m => m.id === id);
  assert.equal(plans['opencode-go'].length, plans['opencode-go-plus'].length);
  assert.deepEqual([get('opencode-go', 'glm-5.3').limitUsd, get('opencode-go-plus', 'glm-5.3').limitUsd], [15, 120]);
  assert.deepEqual(get('opencode-go', 'qwen3.7-plus').cost, { input: 0.4, output: 1.6, cache_read: 0.04, cache_write: 0.5, tiers: [{ input: 1.2, output: 4.8, cache_read: 0.12, cache_write: 1.5, tier: { type: 'context', size: 256000 } }] });
  assert.deepEqual([get('opencode-go', 'deepseek-v4-pro').offPeak, get('opencode-go', 'deepseek-v4-pro').cost.input], [true, 0.66]);
  assert.equal(get('opencode-go', 'longcat-2.5-preview-free').limitUsd, null);
  // Every parsed model must pass snapshot validation unchanged.
  for (const plan of Object.keys(plans)) validateSnapshot({ version: 3, plan, pricingAt: now, models: plans[plan], benchmarks: { source: 'arena', fetchedAt: now, entries: [{ slug: 'x', name: 'x', score: 1 }] } });
});

test('docs shape drift fails loudly with the source URL', () => {
  const broken = [
    docs.replace('| Monthly limit', '| Monthly cap'),
    docs.replace('<TabItem label="Go Plus">', '<TabItem label="Plus">'),
    docs.replace('| GLM-5.3                      | glm-5.3', '| GLM 5.3                      | glm-5.3'),
    docs.replace(/\*\*\$15\*\*/, '15 dollars'),
    docs.replace('(Off-Peak)', '(Night)'),
  ];
  for (const text of broken) assert.throws(() => parseGoDocs(text), /OpenCode Go docs changed shape .*raw\.githubusercontent\.com/);
});

test('Go ranks on share of the model\'s monthly limit, not on dollars', () => {
  const models = parseGoDocs(docs)['opencode-go'];
  const entries = models.map((m, i) => ({ slug: m.id, name: m.id, score: 1000 + i }));
  const result = rank({ version: 3, plan: 'opencode-go', pricingAt: now, models, benchmarks: { source: 'arena', fetchedAt: now, entries } }, { mode: 'best', top: 100 });
  const glm53 = result.models.find(m => m.id === 'glm-5.3'), glm52 = result.models.find(m => m.id === 'glm-5.2');
  assert.equal(glm53.costUsd, glm52.costUsd);
  assert.equal(Math.floor(glm53.tasksPerMonth), 81);
  assert.equal(glm52.tasksPerMonth / glm53.tasksPerMonth, 4);
  assert.equal(glm53.dispatchId, 'opencode-go/glm-5.3');
  const free = result.models.find(m => m.id === 'longcat-2.5-preview-free');
  assert.deepEqual([free.unlimited, free.tasksPerMonth, free.rankingCost], [true, null, 0]);
  assert.match(format(result), /TASKS\/MO/);
  assert.match(format(result), /Off-peak prices: .*deepseek-v4-pro/);
  assert.doesNotMatch(format(result), /COST|\$0\./);
  assert.ok(JSON.parse(JSON.stringify(result)).models.every(m => m.tasksPerMonth === null || Number.isFinite(m.tasksPerMonth)));
});

test('Go key reuse: env, then opencode auth.json, then pi auth.json; never runs !commands', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'model-value-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { XDG_DATA_HOME: join(dir, 'data'), PI_CODING_AGENT_DIR: join(dir, 'pi') };
  await mkdir(join(dir, 'data', 'opencode'), { recursive: true });
  await mkdir(join(dir, 'pi'), { recursive: true });
  assert.equal(await findGoKey(env), undefined);
  await writeFile(join(dir, 'pi', 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api_key', key: '!security find-generic-password' } }));
  assert.equal(await findGoKey(env), undefined);
  await writeFile(join(dir, 'pi', 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api_key', key: 'pi-key' } }));
  assert.deepEqual(await findGoKey(env), { key: 'pi-key', source: join(dir, 'pi', 'auth.json') });
  await writeFile(join(dir, 'data', 'opencode', 'auth.json'), JSON.stringify({ opencode: { type: 'api', key: 'zen-key' } }));
  assert.equal((await findGoKey(env)).key, 'zen-key');
  assert.equal((await findGoKey({ ...env, OPENCODE_API_KEY: 'env-key' })).key, 'env-key');
  await writeFile(join(dir, 'data', 'opencode', 'auth.json'), '{oops');
  await assert.rejects(findGoKey(env), /Cannot read .*auth\.json: invalid JSON/);
});
