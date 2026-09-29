// SPDX-License-Identifier: AGPL-3.0-only
//
// `S0-3 store parts` (ticket S0-3, lines C1, C2 and C11; REV158S criterion 5).
// An archive can be as large as the store's cap, past what one value or the
// store's memory holds, so the store keeps it in parts of at most 4 MiB under
// one header row. The job adds them in order in one transaction and completes
// the archive with its size and whole digest; the drill reads them back one by
// one, each checked, into a file. The shared fixture is
// backup-identity.fixture.ts; the live store in its memory-limited container is
// tests/ci/staging-backup-reach-live.test.ts.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  job,
  serverUrl,
  BACKUP,
  RESTORE,
  keys,
  drill,
  seal,
  asRole,
  attempt,
  store,
  backupLogin,
  restoreLogin,
  receipts,
  addArchive,
  backupStoreHooks,
  hostReach,
  PART,
} from './backup-identity.fixture.ts';

const folder = mkdtempSync(join(tmpdir(), 's0-3p-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** What the store holds: archives, parts, receipts and the stored total. */
async function held(): Promise<string> {
  const [row] = await store.admin.execute<{ held: string }>(
    `select concat_ws('/', (select count(*) from backups.archives),
       (select count(*) from backups.archive_parts), (select count(*) from backups.receipts),
       (select bytes from backups.stored)) as held`,
  );
  return row?.held ?? '';
}

/** `dump` streamed in 64 KiB pieces, as pg_dump prints. */
async function* streamed(dump: Buffer): AsyncGenerator<Buffer> {
  for (let at = 0; at < dump.length; at += 65_536) yield dump.subarray(at, at + 65_536);
}

describe.skipIf(serverUrl === undefined)('S0-3 store parts', () => {
  backupStoreHooks();
  orderCases();
  roundTripCases();
  refusalCases();
  overCapCases();
});

/** Each hostile add or completion, and the SQLSTATE the store refuses it with. */
const HOSTILE: Record<string, [string, string[]]> = {
  gap: ['22023', [`select backups.add_part(0, '\\x01')`, `select backups.add_part(2, '\\x02')`]],
  repeat: [
    '22023',
    [
      `select backups.add_part(0, '\\x01')`,
      `select backups.add_part(1, '\\x02')`,
      `select backups.add_part(1, '\\x03')`,
    ],
  ],
  'no part 0': ['22023', [`select backups.add_part(1, '\\x01')`]],
  'two opens': [
    '55000',
    [`select backups.add_part(0, '\\x01')`, `select backups.add_part(0, '\\x02')`],
  ],
  'a negative part': ['22023', [`select backups.add_part(-1, '\\x01')`]],
  'an empty part': ['22023', [`select backups.add_part(0, '\\x')`]],
  'a part too large': [
    '22023',
    [`select backups.add_part(0, decode(repeat('00', ${PART + 1}), 'hex'))`],
  ],
  'complete, none open': ['55000', [`select backups.complete_archive(1, repeat('a', 64))`]],
  'complete, another size': [
    '22023',
    [
      `select backups.add_part(0, '\\x0102')`,
      `select backups.complete_archive(3, repeat('a', 64))`,
    ],
  ],
  'complete, no digest': [
    '22023',
    [`select backups.add_part(0, '\\x0102')`, `select backups.complete_archive(2, 'not a digest')`],
  ],
  'never completed': ['55000', [`select backups.add_part(0, '\\x01')`, 'commit']],
};

function orderCases() {
  it('takes parts only in order from 0, none twice, each 1 byte to 4 MiB', async () => {
    const client = await asRole(backupLogin.url, BACKUP);
    try {
      const before = await held();
      const codes: Record<string, string> = {};
      for (const [what, [, steps]] of Object.entries(HOSTILE)) {
        // oxlint-disable-next-line no-await-in-loop
        codes[what] = await attempt(client, steps.join(';\n'));
      }
      expect(codes).toStrictEqual(
        Object.fromEntries(Object.entries(HOSTILE).map(([what, [code]]) => [what, code])),
      );
      expect(await held()).toBe(before);
    } finally {
      await client.end();
    }
  });
}

type Newest = {
  bytes: string;
  parts: number;
  sum: string;
  stored: string;
  whole: string;
  sha256: string;
};

/** The newest archive as the store holds it: its header, its parts' sum and digest, the total. */
async function newestArchive(): Promise<Newest | undefined> {
  const [row] = await store.admin.execute<Newest>(
    `select a.bytes::text, a.parts, a.sha256,
       (select sum(length(chunk))::text from backups.archive_parts p where p.archive_id = a.id) as sum,
       (select bytes::text from backups.stored) as stored,
       (select encode(sha256(string_agg(chunk, ''::bytea order by seq)), 'hex')
          from backups.archive_parts p where p.archive_id = a.id) as whole
     from backups.archives a order by taken_at desc, id desc limit 1`,
  );
  return row;
}

function roundTripCases() {
  it('a streamed archive of several parts is stored exactly and read back part by part into a file', async () => {
    const before = await receipts();
    const dump = randomBytes(2 * PART + 12_345);
    const { runBackup } = await job();
    const run = await runBackup({
      dump: () => Promise.resolve(streamed(dump)),
      storeUrl: backupLogin.url,
      reach: hostReach,
      publicKey: keys.publicKey,
    });
    expect(run).toMatchObject({ outcome: 'recorded' });
    const row = await newestArchive();
    expect(row?.parts).toBe(3);
    expect(Number(row?.bytes)).toBe(run['bytes']);
    expect(row?.sum).toBe(row?.bytes);
    expect(row?.stored).toBe(row?.bytes);
    expect(row?.sha256).toBe(row?.whole);
    expect((await receipts()).length).toBe(before.length + 1);

    const file = join(folder, 'fetched');
    const { fetchLatest } = await drill();
    const fetched = await fetchLatest(restoreLogin.url, file, hostReach);
    expect(fetched).toMatchObject({ sha256: row?.sha256, bytes: Number(row?.bytes) });
    const sealed = readFileSync(file);
    expect(sha(sealed)).toBe(row?.sha256);
    expect((await seal()).openArchive(sealed, keys.privateKey).equals(dump)).toBe(true);
  });

  it('a part changed in the store fails the fetch, and leaves no file', async () => {
    await store.admin.execute(
      `update backups.archive_parts set chunk = decode(repeat('00', length(chunk)), 'hex')
        where seq = 1 and archive_id = (select id from backups.archives order by taken_at desc, id desc limit 1)`,
    );
    const file = join(folder, 'changed');
    const { fetchLatest } = await drill();
    await expect(fetchLatest(restoreLogin.url, file, hostReach)).rejects.toThrow(
      /^a part of the archive is not the one the store took$/u,
    );
    expect(existsSync(file)).toBe(false);
  });
}

function refusalCases() {
  it('reads a part only of an archive this login read, and only as the restore identity', async () => {
    const [newest] = await store.admin.execute<{ id: string }>(
      'select id::text from backups.archives order by taken_at desc, id desc limit 1',
    );
    const reader = await asRole(restoreLogin.url, RESTORE);
    try {
      expect(await attempt(reader, `select * from backups.read_part(gen_random_uuid(), 0)`)).toBe(
        '42501',
      );
      expect(await attempt(reader, `select * from backups.read_part('${newest?.id}', 0)`)).toBe(
        'ok',
      );
    } finally {
      await reader.end();
    }
    const other = await asRole(backupLogin.url, BACKUP);
    try {
      expect(await attempt(other, `select * from backups.read_part('${newest?.id}', 0)`)).toBe(
        '42501',
      );
    } finally {
      await other.end();
    }
  });
}

function overCapCases() {
  it('an archive over the cap is refused (53400) part way through, and writes nothing', async () => {
    const [row] = await store.admin.execute<{ bytes: string }>(
      'select bytes::text from backups.stored',
    );
    await store.admin.execute(
      `update backups.settings set max_bytes = ${Number(row?.bytes) + 2 * PART}`,
    );
    const before = await held();
    const { runBackup } = await job();
    const run = await runBackup({
      dump: () => Promise.resolve(streamed(randomBytes(3 * PART))),
      storeUrl: backupLogin.url,
      reach: hostReach,
      publicKey: keys.publicKey,
    });
    expect(run).toMatchObject({ outcome: 'failed', stage: 'store' });
    expect(await held()).toBe(before);
    const client = await asRole(backupLogin.url, BACKUP);
    try {
      await addArchive(client, Buffer.alloc(2 * PART, 1));
      expect(await attempt(client, `select backups.add_part(0, '\\x01')`)).toBe('53400');
    } finally {
      await client.end();
    }
  });
}
