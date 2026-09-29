// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3 (REV158S3 criterion 14): the backup job completes an archive with its
// size and whole digest sent as bound parameters (psql's `\bind`), never as
// SQL text, so no statement the store refuses and logs carries the digest;
// and the store's server logs no statement text on an error at all, so a
// refused part never puts its ciphertext in the log either. The live half is
// staging-backup-reach-live.test.ts (Sol's proof, against the real server).

import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Backup = {
  runBackup: (options: Record<string, unknown>) => Promise<{ outcome: string }>;
};
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('S0-3 completion bound', () => {
  it('the job sends the whole digest only as a bound value, never in a statement', async () => {
    const path = '../../scripts/ops/backup.mjs';
    const { runBackup } = (await import(
      /* @vite-ignore */
      path
    )) as Backup;
    let sent = '';
    const reach = async (_url: string, script: string | AsyncIterable<string>) => {
      if (typeof script === 'string') sent += script;
      else for await (const piece of script) sent += piece;
      return '';
    };
    const run = await runBackup({
      dump: () => Promise.resolve(Buffer.from('PGDMP made-up')),
      storeUrl: 'store',
      publicKey: keys.publicKey,
      reach,
      send: () => Promise.resolve('sent'),
    });
    expect(run.outcome).toBe('recorded');
    const lines = sent.split('\n');
    const completion = lines.filter((line) => line.includes('complete_archive'));
    expect(completion).toHaveLength(1);
    const [statement = '', values = ''] = (completion[0] ?? '').split(' \\bind ');
    expect(statement).toBe('select backups.complete_archive($1::bigint, $2::text)');
    const digest = /'([0-9a-f]{64})'/u.exec(values)?.[1] ?? '';
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    // The digest is in the bound values alone: no statement text holds it.
    const statements = lines.map((line) => line.split(' \\bind ')[0] ?? '');
    expect(statements.join('\n')).not.toContain(digest);
  });

  it("the store's server logs no statement text on an error", () => {
    const compose = JSON.parse(
      readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
    ) as { services: Record<string, { command?: string[] }> };
    const command = compose.services['backups']?.command ?? [];
    const settings = command.filter((_, i) => command[i - 1] === '-c');
    expect(settings).toContain('log_min_error_statement=panic');
  });
});
