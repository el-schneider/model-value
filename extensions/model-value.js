import { format, querySchema } from '../src/index.js';
import { query as getRankings } from '../src/query.js';
import { plans, planIds, planAliases, planFor } from '../src/plans.js';

const planWords = [...planIds, ...Object.keys(planAliases)];

export default function (pi) {
  // Plans whose provider has authenticated models in pi. A Go login cannot tell Go from Go Plus, so it yields both.
  const loggedIn = ctx => {
    const providers = new Set(ctx.modelRegistry.getAvailable().map(m => m.provider));
    return planIds.filter(id => providers.has(plans[id].provider));
  };

  async function query(params, ctx, signal) {
    const { plan: word, all = false, offline = false, ...ranking } = params;
    const plan = word ? planFor(word) : only(loggedIn(ctx));
    const available = ctx.modelRegistry.getAvailable().filter(m => m.provider === plan.provider);
    if (!all && !available.length) throw Error(`No authenticated ${plan.label} models in pi. Use /login first, or pass all=true to rank the published catalog.`);
    if (plan.id !== 'github-copilot') return getRankings(ranking, { plan: plan.id, offline, signal, registryModelIds: all ? undefined : available.map(m => m.id) });
    // Resolving pi's rotating Copilot token can refresh it over the network, so offline cannot check subscription eligibility.
    if (!all && offline) throw Error('offline needs all=true for github-copilot in pi: subscription eligibility needs a live check with pi\'s Copilot login');
    const login = all ? undefined : await piLogin(ctx, available[0]);
    return getRankings(ranking, { plan: plan.id, all, offline, signal, login, registryModelIds: all ? undefined : available.map(m => m.id) });
  }
  function only(candidates) {
    if (candidates.length === 1) return plans[candidates[0]];
    throw Error(`${candidates.length ? 'Several plans logged in' : 'No plan logged in'}; pass plan: ${(candidates.length ? candidates : planIds).join(', ')}`);
  }

  // Eligibility must come from the account pi sends requests with, not from gh or token variables.
  async function piLogin(ctx, model) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw Error(`pi Copilot login: ${auth.error}`);
    if (!auth.apiKey || !auth.baseUrl) throw Error('pi returned no Copilot token or endpoint. Update pi or run /login.');
    return { token: auth.apiKey, source: 'pi login', endpoint: auth.baseUrl, help: 'run /login in pi, or pass all=true to rank the published catalog' };
  }

  pi.registerTool({
    name: 'model_value', label: 'Model Value',
    description: 'Rank the models of a multi-vendor subscription for coding: github-copilot (account-enabled models via pi login), opencode-go or opencode-go-plus (published per-model monthly limits). mode=value (default): score frontier, cheapest first (Go: most tasks per month first). mode=best: strongest first. plan defaults to the one plan logged in to pi; Go and Go Plus cannot be told apart, so pass plan for Go. Scores: Artificial Analysis when ARTIFICIAL_ANALYSIS_API_KEY is set, else LMArena WebDev (no key); source overrides. Default scope intersects pi\'s logged-in models; all=true ranks the published catalog. Returns dispatchId; does not switch models, launch workers, or spend inference credits. offline=true permits timestamped stale data (github-copilot also needs all=true). Top 10 by default (max 100).',
    promptSnippet: 'Find a subscription model (GitHub Copilot, OpenCode Go) by benchmark score or workload value.',
    promptGuidelines: [
      'Use model_value when the user explicitly requests model recommendations or workers on GitHub Copilot or OpenCode Go.',
      'model_value returns recommendations, not authorization to spend subscription quota. Use returned dispatchId only after user approval.',
      'model_value mode=value returns the score frontier; with minScore its first row is the cheapest model above the floor. Report plan, score source, benchmark variant and token assumptions. For OpenCode Go, tasksPerMonth assumes only that model is used.',
    ],
    parameters: { ...querySchema, properties: { plan: { type: 'string', enum: planWords, description: 'Default: the one plan logged in to pi. Required for OpenCode Go (Go vs Go Plus)' }, ...querySchema.properties, all: { type: 'boolean', default: false }, offline: { type: 'boolean', default: false } } },
    async execute(_id, params, signal, _update, ctx) {
      const result = await query(params, ctx, signal);
      return { content: [{ type: 'text', text: format(result, { verbose: true }) }], details: result };
    },
  });

  pi.registerCommand('model-value', {
    description: 'Pick a subscription model for this session: /model-value [plan] [value|best]',
    getArgumentCompletions(prefix) {
      return [...planWords, 'value', 'best'].filter(s => s.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    async handler(args, ctx) {
      if (!ctx.hasUI) throw Error('/model-value requires interactive UI or RPC dialogs');
      await ctx.waitForIdle();
      const words = args.trim().split(/\s+/).filter(Boolean);
      const unknown = words.find(w => !planWords.includes(w) && !['value', 'best'].includes(w));
      if (unknown) throw Error(`Unknown argument "${unknown}". Usage: /model-value [${planWords.join('|')}] [value|best]`);
      let plan = words.find(w => planWords.includes(w));
      if (!plan) {
        // Interactive: ask instead of guessing when several plans (or both Go tiers) are possible.
        const candidates = loggedIn(ctx);
        plan = candidates.length === 1 ? candidates[0] : await ctx.ui.select('Which plan?', candidates.length ? candidates : planIds);
        if (plan === undefined) return;
      }
      const result = await query({ plan, mode: words.find(w => w === 'value' || w === 'best') ?? 'value' }, ctx, ctx.signal);
      if (!result.models.length) { ctx.ui.notify(format(result), 'warning'); return; }
      const go = result.plan.id !== 'github-copilot';
      const cost = m => go ? (m.unlimited ? 'unlimited' : `${Math.floor(m.tasksPerMonth)} tasks/mo`) : `$${m.costUsd.toFixed(4)}`;
      const labels = result.models.map(m => `${m.id} · ${m.score.toFixed(1)} · ${cost(m)} · ${m.benchmark.name}`);
      const selected = await ctx.ui.select(`${result.plan.label} · ${result.options.mode} · ${result.source.name} · 100k input / 10k output, uncached`, labels);
      if (selected === undefined) return;
      const winner = result.models[labels.indexOf(selected)];
      if (!winner) throw Error('Unknown model selection');
      const estimate = go ? `${cost(winner)} if used alone ($${winner.costUsd.toFixed(4)} per task)` : `$${winner.costUsd.toFixed(4)} (${winner.aiCredits.toFixed(2)} AI credits)`;
      if (!await ctx.ui.confirm(`Use ${result.plan.label} for this session?`, `${winner.dispatchId}\nBenchmark: ${winner.benchmark.name}\nEstimated workload: ${estimate}.\nBenchmark effort may differ from session thinking. This changes no startup default.`)) return;
      const model = ctx.modelRegistry.find(result.plan.provider, winner.id);
      if (!model || !await pi.setModel(model)) throw Error(`Cannot select ${winner.dispatchId}; check ${result.plan.label} authentication`);
      ctx.ui.notify(`Selected ${winner.dispatchId}. Thinking: ${pi.getThinkingLevel()}. Benchmark variant: ${winner.benchmark.name}`, 'info');
    },
  });
}
