import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEligibility, parseEligibility, eligibilityTtl, resolveToken } from '../src/copilot.js';
import { query } from '../src/query.js';

delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;

const endpoint = 'https://api.githubcopilot.com';
const tokenVars = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'PATH'];
// Fake gh prints its own GH_TOKEN or GITHUB_TOKEN, else gho_<user> for --user, else the keyring token, so tests see what reached it.
async function withEnv(t, vars, ghOutput = 'gho_keyring') {
  const dir = await mkdtemp(join(tmpdir(), 'cv-gh-'));
  await writeFile(join(dir, 'gh'), `#!/bin/sh\nfallback=${ghOutput}\nwhile [ $# -gt 0 ]; do [ "$1" = --user ] && fallback="gho_$2"; shift; done\necho "\${GH_TOKEN:-\${GITHUB_TOKEN:-$fallback}}"\n`, { mode: 0o755 });
  const saved = Object.fromEntries(tokenVars.map(name => [name, process.env[name]]));
  t.after(async () => { for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value; await rm(dir, { recursive: true, force: true }); });
  for (const name of tokenVars.slice(0, 3)) delete process.env[name];
  Object.assign(process.env, vars, { PATH: `${dir}:${saved.PATH}` });
}
const m = (id, picker, state) => ({ id, model_picker_enabled: picker, policy: { state }, capabilities: { supports: { tool_calls: true } } });
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cv-auth-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cache = join(dir, 'snapshot.json');
  await writeFile(cache, JSON.stringify({ version: 3, plan: 'github-copilot', pricingAt: Date.now(), models: ['allowed', 'disabled'].map(id => ({ id, cost: { input: 1, output: 2 } })), benchmarks: { source: 'arena', fetchedAt: Date.now(), entries: ['allowed', 'disabled'].map((slug, i) => ({ slug, name: slug, score: 1500 + i * 100 })) } }));
  return { dir, cache, token: 'fake-github-token' };
}

test('picker/policy parsing excludes disabled, unconfigured and non-tool models', () => {
  const data = [m('allowed', true, 'enabled'), m('disabled', true, 'disabled'), m('unconfigured', true, 'unconfigured'), m('hidden', false, 'enabled'), { ...m('no-tools', true, 'enabled'), capabilities: { supports: { tool_calls: false } } }];
  assert.deepEqual(parseEligibility({ data }).modelIds, ['allowed']);
  assert.deepEqual(parseEligibility({ data: [m('allowed', false, 'enabled'), m('disabled', false, 'disabled')] }).modelIds, ['allowed']);
  assert.throws(() => parseEligibility({}), /Invalid Copilot/);
});

test('default query intersects account eligibility; --all bypasses authentication only explicitly', async t => {
  const { cache, token } = await setup(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, `${endpoint}/models`);
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ data: [m('allowed', true, 'enabled'), m('disabled', true, 'disabled')] }));
  });
  const result = await query({}, { token, cache });
  assert.equal(result.scope, 'copilot-subscription');
  assert.deepEqual(result.models.map(m => m.id), ['allowed']);
  assert.equal(calls, 1);
  const narrowed = await query({}, { token, cache, modelIds: ['disabled', 'github-copilot/disabled', 'github-copilot/allowed'] });
  assert.deepEqual(narrowed.models.map(m => m.id), ['allowed']);
  assert.deepEqual(narrowed.skipped, [{ id: 'disabled', reason: 'Not enabled on this account' }]);
  assert.equal((await query({}, { token, cache, offline: true })).models[0].id, 'allowed');
  assert.equal(calls, 1);
  assert(!(await readFile(`${cache}.eligibility.json`, 'utf8')).includes('fake-'));
  const publicRank = await query({}, { token: undefined, cache, all: true, offline: true });
  assert.equal(publicRank.models[0].id, 'disabled');
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'copilot', '--cache', cache, '--offline', '--json'], { encoding: 'utf8', env: { ...process.env, COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: token } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).models[0].id, 'allowed');
  assert.equal(run.stdout.includes('fake-github'), false);
});

test('cache is token-bound and offline is network-free', async t => {
  const { dir, token } = await setup(t);
  const cache = join(dir, 'account.json');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [m('allowed', true, 'enabled')] })));
  const e = await loadEligibility({ token, cache });
  await writeFile(cache, JSON.stringify({ ...e, fetchedAt: Date.now() - eligibilityTtl - 1000 }));
  assert.equal((await loadEligibility({ token, cache, offline: true })).stale, true);
  await assert.rejects(loadEligibility({ token: 'other-token', cache, offline: true }), /No matching offline eligibility/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('enterprise host routes to copilot-api and rejects other domains', async t => {
  const { cache, token } = await setup(t);
  t.mock.method(globalThis, 'fetch', async url => { assert.equal(url, 'https://copilot-api.corp.ghe.com/models'); return new Response(JSON.stringify({ data: [] })); });
  await loadEligibility({ token, host: 'corp.ghe.com', cache, refresh: true });
  await assert.rejects(loadEligibility({ token, host: 'evil.example', cache, refresh: true }), /Unsupported Copilot enterprise host/);
});

test('authorization failures never fall back to the published catalog', async t => {
  const { cache, token } = await setup(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 403 }));
  await assert.rejects(query({}, { token, cache }), /HTTP 403/);
  await assert.rejects(query({}, { token: 'fake-secret', cache }), error => !error.message.includes('fake-secret'));
  t.mock.method(globalThis, 'fetch', async () => new Response('bad request: Personal Access Tokens are not supported', { status: 400 }));
  await assert.rejects(query({}, { token, cache }), /HTTP 400 \(bad request: Personal Access Tokens are not supported\)\nToken from token option rejected/);
});

test('token precedence skips classic PATs only in shared variables', async t => {
  await withEnv(t, { COPILOT_GITHUB_TOKEN: 'github_pat_copilot', GH_TOKEN: 'gho_gh', GITHUB_TOKEN: 'gho_github' });
  assert.deepEqual(await resolveToken(), { token: 'github_pat_copilot', source: 'COPILOT_GITHUB_TOKEN', skipped: [] });
  assert.equal((await resolveToken({ token: 'gho_explicit' })).token, 'gho_explicit');
  delete process.env.COPILOT_GITHUB_TOKEN;
  assert.equal((await resolveToken()).source, 'GH_TOKEN');
  process.env.GH_TOKEN = 'ghp_classic';
  assert.deepEqual(await resolveToken(), { token: 'gho_github', source: 'GITHUB_TOKEN', skipped: ['GH_TOKEN'] });
  process.env.GITHUB_TOKEN = 'ghp_classic';
  assert.deepEqual(await resolveToken({ host: 'corp.ghe.com' }), { token: 'gho_keyring', source: 'gh login', skipped: ['GH_TOKEN', 'GITHUB_TOKEN'] });
  process.env.COPILOT_GITHUB_TOKEN = 'ghp_classic';
  await assert.rejects(resolveToken(), /COPILOT_GITHUB_TOKEN is a classic PAT/);
  await assert.rejects(resolveToken({ token: 'ghp_classic' }), /token option is a classic PAT/);
});

test('user picks a gh account and overrides token variables', async t => {
  const { cache } = await setup(t);
  await withEnv(t, { COPILOT_GITHUB_TOKEN: 'github_pat_copilot', GH_TOKEN: 'gho_gh', GITHUB_TOKEN: 'gho_github' });
  assert.deepEqual(await resolveToken({ user: 'alice' }), { token: 'gho_alice', source: 'gh login (alice)', skipped: [] });
  assert.deepEqual(await resolveToken({ user: 'bob_corp', host: 'corp.ghe.com' }), { token: 'gho_bob_corp', source: 'gh login (bob_corp)', skipped: [] });
  assert.equal((await resolveToken({ token: 'gho_explicit', user: 'alice' })).token, 'gho_explicit');
  await assert.rejects(resolveToken({ user: '--hostname' }), /Invalid GitHub user/);
  t.mock.method(globalThis, 'fetch', async (_url, { headers }) => {
    assert.equal(headers.Authorization, 'Bearer gho_alice');
    return new Response(JSON.stringify({ data: [m('allowed', true, 'enabled')] }));
  });
  assert.equal((await query({}, { cache, user: 'alice' })).eligibility.tokenSource, 'gh login (alice)');
});

test('no usable token fails before network', async t => {
  await withEnv(t, { GH_TOKEN: 'ghp_classic' }, 'ghp_keyring');
  t.mock.method(globalThis, 'fetch', () => assert.fail('network'));
  await assert.rejects(loadEligibility({ cache: join(tmpdir(), 'cv-unused.json'), refresh: true }), /GH_TOKEN ignored.*gh login returned a classic PAT/);
});

test('skipped tokens are reported, rejections name the source and never echo the token', async t => {
  const { cache } = await setup(t);
  await withEnv(t, { GH_TOKEN: 'ghp_classic', GITHUB_TOKEN: 'gho_secret' });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [m('allowed', true, 'enabled')] })));
  const result = await query({}, { cache });
  assert.deepEqual([result.eligibility.tokenSource, result.eligibility.skippedTokens], ['GITHUB_TOKEN', ['GH_TOKEN']]);
  assert.match(result.caveats[0], /Ignored GH_TOKEN: classic PAT/);
  t.mock.method(globalThis, 'fetch', async () => new Response('denied for gho_secret', { status: 403 }));
  await assert.rejects(query({}, { cache, refresh: true }), error => /HTTP 403 \(denied for \[token\]\)\nToken from GITHUB_TOKEN rejected/.test(error.message));
});
