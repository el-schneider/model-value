import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// One OpenCode key serves Zen and Go. Reuse what the user already configured for opencode or pi instead of
// asking for a new variable. The key only hints that the user has Go: ranking needs none, because Go prices
// and limits are public, and a Zen key alone does not prove a Go subscription.
export function keyLocations(env = process.env) {
  const opencode = join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'auth.json');
  const pi = join(env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'auth.json');
  return [
    { source: 'OPENCODE_API_KEY', read: () => env.OPENCODE_API_KEY },
    { source: opencode, read: async () => { const a = await json(opencode); return entryKey(a?.['opencode-go'], 'api') ?? entryKey(a?.opencode, 'api'); } },
    { source: pi, read: async () => entryKey((await json(pi))?.['opencode-go'], 'api_key') },
  ];
}

async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw Error(`Cannot read ${path}: ${error instanceof SyntaxError ? 'invalid JSON' : error.code ?? 'read failed'}`);
  }
}
// pi allows "!command" keys resolved through a shell; model-value does not run commands from config files.
const entryKey = (entry, type) => entry?.type === type && typeof entry.key === 'string' && entry.key && !entry.key.startsWith('!') ? entry.key : undefined;

export async function findGoKey(env = process.env) {
  for (const { source, read } of keyLocations(env)) {
    const key = await read();
    if (key) return { key, source };
  }
  return undefined;
}
