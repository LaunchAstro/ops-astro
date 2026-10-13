// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('auth-up recovers an existing empty signing-key file', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'proof-empty-key-'));
  try {
    const scripts = join(scratch, 'scripts/local');
    const local = join(scratch, '.local');
    const bin = join(scratch, 'bin');
    for (const dir of [scripts, local, bin]) mkdirSync(dir, { recursive: true });
    for (const file of ['auth-up.sh', 'signing-key.mjs'])
      copyFileSync(join(import.meta.dirname, '../../scripts/local', file), join(scripts, file));
    writeFileSync(join(local, 'auth-signing-key.json'), '');
    writeFileSync(join(local, 'db.env'), 'DATABASE_URL=synthetic-test-url\n');
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh
case "$*" in
  *ops-astro-local-pg*Mounts*) printf '%s\\n' ops-astro-local-pgdata-17 ;;
  *ops-astro-local-pg*Config.Image*) printf '%s\\n' 'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24' ;;
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
    const done = spawnSync('bash', [join(scripts, 'auth-up.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      encoding: 'utf8',
    });
    expect(done.status, 'auth-up should finish successfully').toBe(0);
    const kept = readFileSync(join(local, 'auth-signing-key.json'), 'utf8');
    expect(kept.length, 'a successful auth-up must leave a durable signing key').toBeGreaterThan(0);
    expect(JSON.parse(kept)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kty: 'EC' })]),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
