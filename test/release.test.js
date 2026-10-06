import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/release-changelog.js', import.meta.url));

test('release-changelog moves Unreleased entries under the version and prints them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cv-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'));
  await copyFile(script, join(dir, 'scripts', 'release-changelog.js'));
  const changelog = join(dir, 'CHANGELOG.md');
  const run = version => spawnSync(process.execPath, [join(dir, 'scripts', 'release-changelog.js'), version], { encoding: 'utf8' });

  await writeFile(changelog, '# Changelog\n\n## Unreleased\n\n- New thing.\n- Fix.\n\n## 0.5.0\n\n- Old.\n');
  const released = run('0.6.0');
  assert.equal(released.status, 0, released.stderr);
  assert.equal(released.stdout, '- New thing.\n- Fix.\n');
  assert.equal(await readFile(changelog, 'utf8'), '# Changelog\n\n## Unreleased\n\n## 0.6.0\n\n- New thing.\n- Fix.\n\n## 0.5.0\n\n- Old.\n');

  assert.match(run('0.6.1').stderr, /no entries under ## Unreleased/);
  assert.match(run('0.6.0').stderr, /already has ## 0\.6\.0/);
  assert.match(run('v0.7.0').stderr, /Invalid version/);
  await writeFile(changelog, '# Changelog\n\n## 0.5.0\n\n- Old.\n');
  assert.match(run('0.6.0').stderr, /no entries under ## Unreleased/);
  await writeFile(changelog, '# Changelog\n\n## Unreleased\n\n- Last entry, no older versions.\n');
  assert.equal(run('0.1.0').stdout, '- Last entry, no older versions.\n');
});
