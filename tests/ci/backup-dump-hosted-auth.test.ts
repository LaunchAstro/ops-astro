// SPDX-License-Identifier: AGPL-3.0-only
//
// #999: on hosted Supabase the `auth` schema is the platform's and the backup
// identity cannot read it, so the hosted dump leaves it out; any other source
// is dumped with `auth`, which its migrations checked readable.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const originalPath = process.env['PATH'];
const originalCapture = process.env['DUMP_CAPTURE_PATH'];

afterEach(() => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  if (originalCapture === undefined) delete process.env['DUMP_CAPTURE_PATH'];
  else process.env['DUMP_CAPTURE_PATH'] = originalCapture;
});

/** The schemas pg_dump is asked for when the job dumps `source`. */
async function dumpedSchemas(source: string): Promise<string[]> {
  const directory = mkdtempSync(join(tmpdir(), 'dump-auth-'));
  try {
    const capture = join(directory, 'docker.json');
    const docker = join(directory, 'docker');
    writeFileSync(
      docker,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.DUMP_CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));
process.stdout.write('PGDMP fixture');
`,
    );
    chmodSync(docker, 0o755);
    process.env['PATH'] = `${directory}${delimiter}${originalPath ?? ''}`;
    process.env['DUMP_CAPTURE_PATH'] = capture;
    const path = '../../scripts/ops/backup-dump.mjs';
    const { pgDump }: { pgDump: (url: string) => Promise<AsyncIterable<Buffer>> } = await import(
      /* @vite-ignore */
      path
    );
    const pieces = await pgDump(source);
    // Read to the end, so pg_dump has exited and its arguments are on disk.
    for await (const piece of pieces) expect(piece.length).toBeGreaterThan(0);
    const args = JSON.parse(readFileSync(capture, 'utf8')) as string[];
    return args.filter((arg) => arg.startsWith('--schema=')).map((arg) => arg.slice(9));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.each(['aws-0-ap-southeast-2.pooler.supabase.com', 'AWS-1-AP-SOUTHEAST-2.POOLER.SUPABASE.COM'])(
  'leaves the platform-owned auth schema out of a dump from the Supabase pooler %s',
  async (host) => {
    expect(
      await dumpedSchemas(`postgres://backup.ref:made-up@${host}:5432/postgres`),
    ).toStrictEqual(['public', 'ops', 'ops_astro_made_up']);
  },
);

it.each([
  'backups',
  'supabase.com.example.test',
  'pooler.supabase.com.evil.test',
  'a.b.pooler.supabase.com',
])('dumps auth from any other source, including the look-alike %s', async (host) => {
  expect(await dumpedSchemas(`postgres://backup:made-up@${host}:5432/postgres`)).toStrictEqual([
    'public',
    'ops',
    'auth',
    'ops_astro_made_up',
  ]);
});
