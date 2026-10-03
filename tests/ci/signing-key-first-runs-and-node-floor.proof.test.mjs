// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '../..');
const scratch = () => mkdtempSync(join(tmpdir(), 'sol-ow061-proof-'));
const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

test('signing-key emits a key on the declared minimum Node version', () => {
  const engines = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).engines.node;
  const floor = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(engines);
  assert.ok(floor, 'read the actual declared engine floor');
  const version = `${floor[1]}.${floor[2] ?? '0'}.${floor[3] ?? '0'}`;
  const run = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      'sol-ow061-node24-proof',
      '--network',
      'none',
      '-v',
      `${join(repo, 'scripts/local/signing-key.mjs')}:/proof/signing-key.mjs:ro`,
      `node:${version}-alpine`,
      'node',
      '/proof/signing-key.mjs',
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(run.status, 0, 'Node must run the actual script successfully');
  // Never include stdout in a failure: it could contain a private key.
  assert.ok(
    run.stdout.trim().length > 0,
    'Node 24.0.0 exits successfully with no key because import.meta.main is undefined; auth-up then refuses its empty key file',
  );
});

async function untilFile(file, required = true) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(file)) return true;
    await delay(10);
  }
  if (required) throw new Error(`barrier not reached: ${file}`);
  return false;
}

function start(script, env) {
  const child = spawn('bash', [script], { env });
  let error = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => {
    error += String(chunk);
  });
  const done = new Promise((resolveRun) =>
    child.once('close', (status) => resolveRun({ status, error })),
  );
  return { child, done };
}

test('simultaneous first auth-up runs both finish with one durable signing key', async () => {
  const root = scratch();
  const children = [];
  try {
    const scripts = join(root, 'scripts/local');
    const bin = join(root, 'bin');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(bin);
    for (const name of ['auth-up.sh', 'signing-key.mjs'])
      copyFileSync(join(repo, 'scripts/local', name), join(scripts, name));
    // Docker is deliberately already settled; only the new key's filesystem
    // critical section is scheduled. No shared or real containers are touched.
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh
case "$*" in
  'inspect ops-astro-local-auth') exit 1 ;;
  *State.Running*ops-astro-local-auth*) printf false ;;
  *Mounts*) printf ops-astro-local-pgdata-17 ;;
  *Config.Image*) printf postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 ;;
  *State.Running*ops-astro-local-pg*) printf true ;;
  *Id*) printf sol-proof-pg ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf "{}\\n"\n', { mode: 0o755 });
    // When generation overlaps, both real generators finish writing before
    // either returns to its parent. A serialising fix can keep the second
    // generator out entirely until the first caller releases its lock.
    writeFileSync(
      join(bin, 'node'),
      `#!/bin/sh
${shellQuote(process.execPath)} "$@" || exit $?
touch "$SOL_KEY_BARRIER/written-$SOL_CALLER"
while [ ! -f "$SOL_KEY_BARRIER/release-$SOL_CALLER" ]; do sleep 0.01; done
`,
      { mode: 0o755 },
    );
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, SOL_KEY_BARRIER: root };
    const first = start(join(scripts, 'auth-up.sh'), { ...env, SOL_CALLER: 'first' });
    children.push(first.child);
    await untilFile(join(root, 'written-first'));
    const second = start(join(scripts, 'auth-up.sh'), { ...env, SOL_CALLER: 'second' });
    children.push(second.child);
    await untilFile(join(root, 'written-second'), false);
    writeFileSync(join(root, 'release-first'), '');
    const a = await first.done;
    const promoted = readFileSync(join(root, '.local/auth-signing-key.json'), 'utf8');
    writeFileSync(join(root, 'release-second'), '');
    const b = await second.done;
    assert.equal(a.status, 0, 'first startup must finish');
    assert.equal(
      b.status,
      0,
      `second startup lost the common signing-key temporary path: ${b.error}`,
    );
    const finalKey = readFileSync(join(root, '.local/auth-signing-key.json'), 'utf8');
    assert.ok(
      finalKey === promoted,
      'second startup must not replace the key the first startup already adopted',
    );
    assert.equal(JSON.parse(finalKey).length, 1);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
