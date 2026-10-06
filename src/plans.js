// A plan is a subscription that bills models from many vendors against one allowance.
// provider: the models.dev and pi provider id, also the prefix of dispatchId.
// perModelLimit: OpenCode Go weighs each model's spend by its own monthly dollar limit; Copilot charges
// token prices against one credit pool, so its ranking axis is the plain cost.
export const plans = {
  'github-copilot': { id: 'github-copilot', label: 'GitHub Copilot', provider: 'github-copilot' },
  'opencode-go': { id: 'opencode-go', label: 'OpenCode Go', provider: 'opencode-go', perModelLimit: true },
  'opencode-go-plus': { id: 'opencode-go-plus', label: 'OpenCode Go Plus', provider: 'opencode-go', perModelLimit: true },
};
export const planAliases = { copilot: 'github-copilot' };
export const planIds = Object.keys(plans);

export function planFor(word) {
  const id = planAliases[word] ?? word;
  if (!plans[id]) throw Error(`Unknown plan: ${word}. Expected ${[...planIds, ...Object.keys(planAliases)].join(', ')}`);
  return plans[id];
}
