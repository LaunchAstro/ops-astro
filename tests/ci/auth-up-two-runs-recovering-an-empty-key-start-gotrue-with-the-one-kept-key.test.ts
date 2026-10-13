// SPDX-License-Identifier: AGPL-3.0-only
//
// Two first runs of auth-up.sh at once, on a checkout with no signing key yet,
// must both finish and both start GoTrue with the one key the file keeps. The
// real script runs over a PATH whose docker answers as a machine with the
// database already up and no GoTrue, and whose key generator waits until both
// runs are generating, so the two always overlap.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const PINNED = 'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';

/** A key generator that prints a new key once both runs have started one. */
const GENERATOR = `import { readdirSync, writeFileSync } from 'node:fs';
const waiting = process.env.KEY_BARRIER;
writeFileSync(waiting + '/' + process.pid, '');
const until = Date.now() + 5000;
while (readdirSync(waiting).length < 2 && Date.now() < until)
  await new Promise((done) => setTimeout(done, 20));
const { generateSigningKeys } = await import('./real-signing-key.mjs');
process.stdout.write(JSON.stringify(await generateSigningKeys()) + '\\n');
`;

function run(
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (bytes: Buffer) => (out += bytes.toString()));
    child.stderr.on('data', (bytes: Buffer) => (out += bytes.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out }));
  });
}

/**
 * A checkout in `scratch` with no signing key, and a PATH whose docker answers
 * as a machine with the database up and no GoTrue. Each GoTrue start is logged
 * to a file of its own in `started`, since two long lines appended to one file
 * at once can interleave. Returns the script and the environment to run it in.
 */
function machine(scratch: string): { script: string; env: NodeJS.ProcessEnv; started: string } {
  const scripts = join(scratch, 'scripts/local');
  const bin = join(scratch, 'bin');
  const barrier = join(scratch, 'barrier');
  const started = join(scratch, 'started');
  for (const dir of [scripts, bin, barrier, started, join(scratch, '.local')])
    mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, 'scripts/local/auth-up.sh'), join(scripts, 'auth-up.sh'));
  copyFileSync(join(ROOT, 'scripts/local/signing-key.mjs'), join(scripts, 'real-signing-key.mjs'));
  writeFileSync(join(scripts, 'signing-key.mjs'), GENERATOR);
  writeFileSync(join(scratch, '.local/db.env'), 'DATABASE_URL=synthetic-test-url\n');
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
case "$*" in
  run*'--name ops-astro-local-auth'*) printf '%s\\n' "$*" > '${started}'/$$ ;;
  *ops-astro-local-pg*Mounts*) printf '%s\\n' ops-astro-local-pgdata-17 ;;
  *ops-astro-local-pg*Config.Image*) printf '%s\\n' '${PINNED}' ;;
  *State.Running*'ops-astro-local-pg') printf '%s\\n' true ;;
  *'{{.Id}}'*) printf '%s\\n' synthetic-postgres-id ;;
  *ops-astro-local-auth) exit 1 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'curl'), "#!/bin/sh\nprintf 'healthy\\n'\n", { mode: 0o755 });
  writeFileSync(join(bin, 'openssl'), '#!/bin/sh\nprintf synthetic-test-secret\n', {
    mode: 0o755,
  });
  const env = { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, KEY_BARRIER: barrier };
  return { script: join(scripts, 'auth-up.sh'), env, started };
}

it('empty-key recovery never replaces a signing key already used by a successful run', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'auth-up-key-race-'));
  try {
    const { script, env, started } = machine(scratch);
    writeFileSync(join(scratch, '.local/auth-signing-key.json'), '');
    // Hold both mv invocations AFTER their shell test observed an empty file.
    // The first proceeds; the second waits until the first started GoTrue.
    const moves = join(scratch, 'moves');
    mkdirSync(moves);
    writeFileSync(
      join(scratch, 'bin/mv'),
      `#!/bin/sh
slot=first
if ! mkdir '${moves}/owner' 2>/dev/null; then slot=second; fi
if [ "$slot" = first ]; then
  touch '${moves}/ready'
  while [ ! -f '${moves}/second' ]; do sleep 0.01; done
else
  touch '${moves}/second'
  while [ "$(ls '${started}' | wc -l)" -lt 1 ]; do sleep 0.01; done
fi
/bin/mv "$@"
`,
      { mode: 0o755 },
    );
    const runs = await Promise.all([1, 2].map(() => run(script, env)));
    const kept = readFileSync(join(scratch, '.local/auth-signing-key.json'));
    const label = createHash('sha256').update(kept).digest('hex').slice(0, 16);
    const labels = readdirSync(started).map(
      (file) =>
        /ops-astro\.signing-key=(\S+)/u.exec(readFileSync(join(started, file), 'utf8'))?.[1],
    );
    expect(labels.length, runs.map((r) => r.out).join('\n')).toBeGreaterThan(0);
    expect(labels, 'Every successful GoTrue start must use the durable signing key').toEqual(
      labels.map(() => label),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
