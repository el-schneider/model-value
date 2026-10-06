// Daily CI check against the live OpenCode Go docs. Fails (never edits, never files issues) when:
// the strict parser breaks, a documented model is not served, or the prose that defines how limits
// work changes. Prose drift needs a human: it can change what tasksPerMonth means without changing tables.
// Update the snapshot after review: node scripts/check-go-docs.js --update
import { readFile, writeFile } from 'node:fs/promises';
import { parseGoDocs, docsSource } from '../src/opencode-go.js';

const proseFile = new URL('../test/fixtures/go-usage-prose.txt', import.meta.url);
const get = async url => { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw Error(`${url}: HTTP ${r.status}`); return r; };
const docs = await (await get(docsSource)).text();
const plans = parseGoDocs(docs);
// Non-table lines that define limits and prices: the "Usage limits" section up to its first subsection.
const start = docs.indexOf('\n## Usage limits\n');
const prose = docs.slice(start, docs.indexOf('\n### ', start)).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('|')).join('\n') + '\n';
if (process.argv.includes('--update')) { await writeFile(proseFile, prose); console.log(`Updated ${proseFile.pathname}`); process.exit(0); }

const problems = [];
const saved = await readFile(proseFile, 'utf8');
if (saved !== prose) problems.push(`Usage-limits prose changed. Review ${docsSource}, then run: node scripts/check-go-docs.js --update\n--- saved\n${saved}--- live\n${prose}`);
const served = new Set((await (await get('https://opencode.ai/zen/go/v1/models')).json()).data.map(m => m.id));
for (const [plan, models] of Object.entries(plans)) for (const m of models) if (!served.has(m.id)) problems.push(`${plan}: documented model ${m.id} is not served by /zen/go/v1/models`);
const documented = new Set(plans['opencode-go'].map(m => m.id));
console.log(`Parsed ${plans['opencode-go'].length} Go / ${plans['opencode-go-plus'].length} Go Plus models. Served without published limit (not ranked): ${[...served].filter(id => !documented.has(id)).join(', ') || 'none'}`);
if (problems.length) { console.error(problems.join('\n\n')); process.exit(1); }
