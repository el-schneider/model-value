import { loadSnapshot, rank, options, defaultCache } from './index.js';
import { loadEligibility, resolveToken, skippedTokenNotice } from './copilot.js';
import { findGoKey } from './opencode-auth.js';
import { planFor } from './plans.js';

export async function query(raw = {}, { plan = 'github-copilot', all = false, modelIds, registryModelIds, mappings, ...sourceOptions } = {}) {
  const p = planFor(plan);
  const copilot = p.id === 'github-copilot';
  const rankingOptions = options(raw);
  const cache = sourceOptions.cache ?? defaultCache(p.id, rankingOptions.source);
  const strip = id => id.startsWith(`${p.provider}/`) ? id.slice(p.provider.length + 1) : id;
  let eligible;
  // Only Copilot has an entitlement API; OpenCode Go serves the same published models to every subscriber.
  if (copilot && !all) {
    // A caller login rotates independently of gh, so it keeps its own file instead of evicting the CLI's.
    const name = sourceOptions.login ? `eligibility-${sourceOptions.login.source.replace(/\W+/g, '-')}` : 'eligibility';
    eligible = await loadEligibility({ ...sourceOptions, cache: `${cache}.${name}.json` });
  }
  const wanted = modelIds?.map(strip);
  const allowed = (eligible?.modelIds ?? registryModelIds ?? wanted)?.filter(id => (!wanted || wanted.includes(id)) && (!registryModelIds || registryModelIds.includes(id)));
  const snapshot = await loadSnapshot({ ...sourceOptions, plan: p.id, cache, source: rankingOptions.source });
  // Arena needs no key, so it can always second-guess AA; AA can back up Arena only when a key is set.
  const other = rankingOptions.source === 'aa' ? 'arena' : process.env.ARTIFICIAL_ANALYSIS_API_KEY ? 'aa' : null;
  const secondary = rankingOptions.mode === 'value' && rankingOptions.margin && other
    ? await loadSnapshot({ ...sourceOptions, plan: p.id, source: other, cache: sourceOptions.cache ? `${cache}.${other}.json` : defaultCache(p.id, other), optional: true })
    : undefined;
  const result = rank(snapshot, rankingOptions, { modelIds: allowed, mappings, secondary });
  if (eligible) {
    result.scope = 'copilot-subscription';
    result.eligibility = { fetchedAt: eligible.fetchedAt, stale: eligible.stale, source: `${eligible.endpoint}/models`, selection: eligible.selection, enabledCount: eligible.modelIds.length, tokenSource: eligible.tokenSource, skippedTokens: eligible.skippedTokens };
    result.caveats[0] = 'Availability comes from the current GitHub token; cached eligibility can change. No remaining-quota check.';
    if (eligible.skippedTokens.length) result.caveats.unshift(skippedTokenNotice(eligible));
  }
  return result;
}

// Plans the local credentials point to. A Go key cannot tell Go from Go Plus, so it yields both
// and the caller must ask instead of guessing; the rankings differ between tiers.
export async function detectPlans({ host, user } = {}) {
  const found = [];
  try { await resolveToken({ host, user }); found.push({ plan: 'github-copilot', source: 'GitHub login' }); }
  catch { /* no usable GitHub token: Copilot simply is not detected */ }
  const go = await findGoKey();
  if (go) found.push({ plan: 'opencode-go', source: go.source }, { plan: 'opencode-go-plus', source: go.source });
  return found;
}
