// SPDX-License-Identifier: AGPL-3.0-only
// R6 attack on a1320ad09: complete, unlisted addresses the new quote framing
// or the `}` and quote-only rules exempt. Each case should be refused.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const checker = resolve(import.meta.dirname, '../../scripts/public-content-check.mjs');
const host = 'alpha.local';
const approved = ['ada', '@', host].join('');

function scan(text, scope = 'blob') {
  const repo = mkdtempSync(join(tmpdir(), 'address-attack-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Gate Test');
    git('config', 'user.email', scope === 'identity' ? text : 'gate@example.invalid');
    writeFileSync(
      join(repo, scope === 'path' ? text : 'contact.txt'),
      scope === 'blob' ? `${text}\n` : 'neutral bytes\n',
    );
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'neutral note');
    const result = spawnSync(process.execPath, [checker, '--repo', repo, '--range', 'HEAD'], {
      encoding: 'utf8',
    });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function refused(text, scope = 'blob') {
  assert.equal(scan(approved, scope).status, 0, 'control passes');
  const result = scan(text, scope);
  assert.equal(result.status, 1, `${JSON.stringify(text)} passed\n${result.output}`);
}

// Framing: the next quote is unrelated, but no letter or digit follows it.
for (const scope of ['blob', 'path', 'identity']) {
  test(`a local part ending in a bare brace is refused in a ${scope}`, () => {
    refused(['ada}', '@', host].join(''), scope);
  });
}

test('a braced name with no placeholder dollar is refused in a blob', () => {
  refused(`Contact ${['{ada}', '@', host].join('')} today.`);
});

// The quote-only rule: an unframed local part of quote marks is still an address.
test('an unframed local part of two apostrophes is refused in a blob', () => {
  refused(`Contact ${["''", '@', host].join('')} today.`);
});
