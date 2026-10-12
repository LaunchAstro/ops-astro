// SPDX-License-Identifier: AGPL-3.0-only
//
// Two first runs of auth-up.sh at once, on a checkout with no signing key yet,
// must both finish and both start GoTrue with the one key the file keeps. The
// real script runs over a PATH whose docker answers as a machine with the
// database already up and no GoTrue, and whose key generator waits until both
// runs are generating, so the two always overlap.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
process.stdout.write(JSON.stringify([{ kid: crypto.randomUUID() }]) + '\\n');
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
 * to `started`. Returns the script and the environment to run it in.
 */
function machine(scratch: string): { script: string; env: NodeJS.ProcessEnv; started: string } {
  const scripts = join(scratch, 'scripts/local');
  const bin = join(scratch, 'bin');
  const barrier = join(scratch, 'barrier');
  for (const dir of [scripts, bin, barrier, join(scratch, '.local')])
    mkdirSync(dir, { recursive: true });
  copyFileSync(join(ROOT, 'scripts/local/auth-up.sh'), join(scripts, 'auth-up.sh'));
  writeFileSync(join(scripts, 'signing-key.mjs'), GENERATOR);
  writeFileSync(join(scratch, '.local/db.env'), 'DATABASE_URL=synthetic-test-url\n');
  const started = join(scratch, 'started');
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
case "$*" in
  run*'--name ops-astro-local-auth'*) printf '%s\\n' "$*" >> '${started}' ;;
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

it('two first runs of auth-up at once both start GoTrue with the one signing key kept', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'auth-up-first-runs-'));
  try {
    const { script, env, started } = machine(scratch);
    const runs = await Promise.all([1, 2].map(() => run(script, env)));

    expect(
      runs.map((r) => r.status),
      runs.map((r) => r.out).join('\n'),
    ).toEqual([0, 0]);
    const kept = readFileSync(join(scratch, '.local/auth-signing-key.json'));
    const label = createHash('sha256').update(kept).digest('hex').slice(0, 16);
    const labels = readFileSync(started, 'utf8')
      .trim()
      .split('\n')
      .map((line) => /ops-astro\.signing-key=(\S+)/u.exec(line)?.[1]);
    expect(labels).toEqual([label, label]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
