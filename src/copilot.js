import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cacheDir } from './index.js';

export const eligibilityTtl = 15 * 60 * 1000;
const headers = {
  Accept: 'application/json',
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'X-GitHub-Api-Version': '2026-06-01',
};

const tokenHelp = 'run gh auth login, or set COPILOT_GITHUB_TOKEN to a fine-grained PAT with the "Copilot Requests" permission';
const isClassicPat = token => token.startsWith('ghp_');

// Plain GitHub tokens work for /models; no Copilot session-token exchange needed.
// Copilot rejects classic PATs outright, so generic shared variables holding one are skipped;
// an explicit token or COPILOT_GITHUB_TOKEN is authoritative and fails instead of switching identity.
// A user picks that gh account and overrides every variable, which cannot name an account.
export async function resolveToken({ token, host, user } = {}) {
  if (user !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(user)) throw Error(`Invalid GitHub user: ${user}`);
  const [source, value] = token !== undefined ? ['token option', token] : user ? [] : ['COPILOT_GITHUB_TOKEN', process.env.COPILOT_GITHUB_TOKEN];
  if (value) {
    if (isClassicPat(value)) throw Error(`${source} is a classic PAT (ghp_), which Copilot rejects; ${tokenHelp}`);
    return { token: value, source, skipped: [] };
  }
  const skipped = [];
  for (const name of user ? [] : ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const envToken = process.env[name];
    if (!envToken) continue;
    if (!isClassicPat(envToken)) return { token: envToken, source: name, skipped };
    skipped.push(name);
  }
  const skippedNote = skipped.length ? `${skipped.join(' and ')} ignored (classic PAT, Copilot rejects these); ` : '';
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const ghSource = user ? `gh login (${user})` : 'gh login';
  let ghToken;
  try {
    ghToken = (await promisify(execFile)('gh', ['auth', 'token', ...(host ? ['--hostname', host] : []), ...(user ? ['--user', user] : [])], { encoding: 'utf8', timeout: 10000, env })).stdout.trim();
  } catch (error) {
    throw Error(`No usable GitHub token: ${skippedNote}${tokenHelp} (${error.code === 'ENOENT' ? 'gh CLI not found' : (error.stderr || error.message).trim()})`);
  }
  if (!ghToken || isClassicPat(ghToken)) throw Error(`No usable GitHub token: ${skippedNote}${ghSource} returned ${ghToken ? 'a classic PAT' : 'nothing'}; ${tokenHelp}`);
  return { token: ghToken, source: ghSource, skipped };
}
export const skippedTokenNotice = ({ skippedTokens, tokenSource }) => `Ignored ${skippedTokens.join(' and ')}: classic PAT, which Copilot rejects. Used ${tokenSource} instead.`;

export function endpointFor(host = process.env.GH_HOST) {
  if (!host || host === 'github.com') return 'https://api.githubcopilot.com';
  if (!/^[a-z0-9.-]+\.ghe\.com$/.test(host)) throw Error('Unsupported Copilot enterprise host; expected github.com or *.ghe.com');
  return `https://copilot-api.${host}`;
}

async function jsonFile(path, optional = false) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw Error(`Cannot read ${path}: ${error instanceof SyntaxError ? 'invalid JSON' : error.code ?? 'read failed'}`);
  }
}
async function get(url, { token, source, help }, signal) {
  const response = await fetch(url, {
    headers: { ...headers, Authorization: `Bearer ${token}` }, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = (await response.text()).replaceAll(token, '[token]').replace(/\s+/g, ' ').trim().slice(0, 200);
    const hint = [400, 401, 403].includes(response.status)
      ? `\nToken from ${source} rejected; ${help ?? `${tokenHelp}. Use --all to rank the published catalog without a token.`}`
      : '';
    throw Error(`Copilot ${new URL(url).pathname}: HTTP ${response.status}${body ? ` (${body})` : ''}${hint}`);
  }
  return response.json();
}

export function parseEligibility(raw) {
  if (!Array.isArray(raw?.data)) throw Error('Invalid Copilot model catalog: expected data array');
  const candidates = raw.data.map(m => {
    if (!m || typeof m.id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(m.id)) throw Error('Invalid Copilot model ID');
    return m;
  }).filter(m => m.capabilities?.supports?.tool_calls !== false);
  // Individual accounts can have every picker flag false while policies explicitly enable models.
  const policyOnly = !candidates.some(m => m.model_picker_enabled === true && m.policy?.state !== 'disabled');
  const enabled = candidates.filter(m => {
    if (m.policy?.state === 'disabled' || m.policy?.state === 'unconfigured') return false;
    return policyOnly ? m.policy?.state === 'enabled' : m.model_picker_enabled === true && (m.policy?.state === undefined || m.policy?.state === 'enabled');
  });
  return { modelIds: [...new Set(enabled.map(m => m.id))].sort(), selection: policyOnly ? 'enabled-policy' : 'model-picker' };
}

// login ({ token, source, endpoint, help }) is a caller-owned credential, used as is instead of resolving one.
export async function loadEligibility({ token, host, user, login, cache = join(cacheDir(), 'eligibility.json'), offline = false, refresh = false, signal } = {}) {
  if (offline && refresh) throw Error('offline and refresh cannot be combined');
  host ??= process.env.GH_HOST;
  const endpoint = login?.endpoint ?? endpointFor(host);
  const auth = login ? { ...login, skipped: [] } : await resolveToken({ token, host, user });
  const tokenInfo = { tokenSource: auth.source, skippedTokens: auth.skipped };
  const accountHash = createHash('sha256').update(`${endpoint}\0${auth.token}`).digest('hex');
  const saved = refresh ? undefined : await jsonFile(cache, true);
  if (saved) {
    if (saved.version !== 1 || !Number.isFinite(saved.fetchedAt) || saved.fetchedAt <= 0 || saved.fetchedAt > Date.now() + 60000 || !Array.isArray(saved.modelIds) || saved.modelIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(id))) throw Error(`Invalid eligibility cache ${cache}; delete it or run refresh`);
    if (saved.accountHash === accountHash && (offline || Date.now() - saved.fetchedAt < eligibilityTtl)) return { ...saved, ...tokenInfo, stale: Date.now() - saved.fetchedAt >= eligibilityTtl };
  }
  if (offline) throw Error('No matching offline eligibility cache for current GitHub token; run model-value github-copilot refresh');
  const parsed = parseEligibility(await get(`${endpoint}/models`, auth, signal));
  const result = { version: 1, accountHash, fetchedAt: Date.now(), endpoint, ...parsed };
  await mkdir(dirname(cache), { recursive: true });
  const temp = `${cache}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(result), { mode: 0o600 });
  await rename(temp, cache);
  return { ...result, ...tokenInfo, stale: false };
}
