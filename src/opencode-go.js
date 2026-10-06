// OpenCode Go bills each model against its own monthly dollar limit. The only published source for those
// limits is the docs page; its Markdown source lives in the OpenCode repo, so we parse that strictly.
export const docsSource = 'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx';
export const docsPage = 'https://opencode.ai/docs/go/';
export const tiers = { 'opencode-go': 'Go', 'opencode-go-plus': 'Go Plus' };
const priceHeader = ['Model', 'Input', 'Output', 'Cached Read', 'Cached Write', 'Monthly limit'];
const endpointHeader = ['Model', 'Model ID', 'Endpoint', 'AI SDK Package'];

const fail = message => { throw Error(`OpenCode Go docs changed shape (${message}); update model-value or report it. Source: ${docsSource}`); };

function tables(text) {
  const found = [];
  let current;
  for (const line of text.split('\n').map(l => l.trim())) {
    if (!line.startsWith('|')) { current = undefined; continue; }
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim());
    if (!current) found.push(current = { header: cells, rows: [] });
    else if (!cells.every(c => /^:?-+:?$/.test(c))) current.rows.push(cells);
  }
  return found;
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) fail(`no "${heading}" heading`);
  const end = text.indexOf('\n## ', start + heading.length + 2);
  return text.slice(start, end < 0 ? undefined : end);
}
function tab(text, label) {
  const parts = text.split(/<TabItem label="([^"]+)">/);
  const i = parts.indexOf(label);
  if (i < 0) fail(`no "${label}" tab under Usage limits`);
  return parts[i + 1].split('</TabItem>')[0];
}

function dollars(cell, label) {
  if (cell === 'Free') return 0;
  if (cell === '-') return undefined;
  const m = /^\$(\d+(?:\.\d+)?)$/.exec(cell);
  if (!m) fail(`unreadable ${label} "${cell}"`);
  return Number(m[1]);
}
function limit(cell, name) {
  const m = /^\*\*(?:\$(\d+(?:\.\d+)?)|(Unlimited))\*\*/.exec(cell);
  if (!m) fail(`unreadable monthly limit "${cell}" for ${name}`);
  return m[2] ? null : Number(m[1]);
}
// "Qwen3.7 Plus (> 256K tokens)" → base name plus a context tier; "(Peak)"/"(Off-Peak)" mark time-of-day pricing.
function variant(model) {
  const m = /^(.*?) \((.*)\)$/.exec(model);
  if (!m) return { name: model };
  const [, name, note] = m;
  if (note === 'Off-Peak' || note === 'Peak') return { name, period: note };
  const t = /^(≤|>) (\d+)K tokens$/.exec(note);
  if (!t) fail(`unknown price variant "${note}"`);
  return { name, above: t[1] === '>' ? Number(t[2]) * 1000 : undefined, upTo: t[1] === '≤' ? Number(t[2]) * 1000 : undefined };
}

// Returns { 'opencode-go': [...models], 'opencode-go-plus': [...] } in models.dev's cost shape, plus limitUsd (null = unlimited).
export function parseGoDocs(text) {
  const endpoints = tables(section(text, '## Endpoints')).find(t => same(t.header, endpointHeader)) ?? fail('no endpoint table');
  const ids = new Map(endpoints.rows.map(([name, id]) => [name, id]));
  if (!ids.size) fail('empty endpoint table');
  const usage = section(text, '## Usage limits');
  const plans = {};
  for (const [plan, label] of Object.entries(tiers)) {
    const table = tables(tab(usage, label)).find(t => same(t.header, priceHeader)) ?? fail(`no price table in "${label}" tab`);
    const models = new Map();
    for (const [cell, input, output, cacheRead, cacheWrite, monthly] of table.rows) {
      const v = variant(cell);
      if (v.period === 'Peak') continue;
      const id = ids.get(v.name) ?? fail(`"${v.name}" has prices but no model ID in the endpoint table`);
      const rates = { input: dollars(input, 'input'), output: dollars(output, 'output'), cache_read: dollars(cacheRead, 'cached read'), cache_write: dollars(cacheWrite, 'cached write') };
      if (rates.input === undefined || rates.output === undefined) fail(`missing input/output price for ${v.name}`);
      const m = models.get(id) ?? { id, name: v.name, limitUsd: limit(monthly, v.name), offPeak: v.period === 'Off-Peak' };
      if (limit(monthly, v.name) !== m.limitUsd) fail(`conflicting monthly limits for ${v.name}`);
      if (v.above) (m.cost ??= { tiers: [] }).tiers.push({ ...rates, tier: { type: 'context', size: v.above } });
      else m.cost = { ...rates, tiers: m.cost?.tiers ?? [] };
      models.set(id, m);
    }
    for (const m of models.values()) {
      if (m.cost.input === undefined) fail(`${m.name} has only long-context prices`);
      if (!m.cost.tiers.length) delete m.cost.tiers;
      for (const r of [m.cost, ...(m.cost.tiers ?? [])]) for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
    }
    if (!models.size) fail(`empty "${label}" price table`);
    plans[plan] = [...models.values()];
  }
  return plans;
}
