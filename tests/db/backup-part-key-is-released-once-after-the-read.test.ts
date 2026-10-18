// SPDX-License-Identifier: AGPL-3.0-only
//
// #742: a part is read in two steps (deploy/staging/backup-store-upgrade-3.sql).
// `backups.read_part` hands the part out sealed under a key of its own and
// writes no receipt; `backups.release_part` writes the part-read receipt and
// hands out that key, once, to the login that read the part, while the
// installation still appoints it. The restore command asks the operator gate
// between the two, so a session ended before the store ran the read gets
// nothing it can open (export-session-ended-before-the-store-reads-a-part-gets-no-part.test.ts).

import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BACKUP,
  RESTORE,
  OPERATING_BUSINESS,
  addArchive,
  asRole,
  attempt,
  backupLogin,
  backupStoreHooks,
  loginIn,
  operatorLogin,
  restoreLogin,
  serverUrl,
  store,
  type Client,
} from './backup-identity.fixture.ts';
import { operator } from './backup-drill-records.fixture.ts';

const RELEASE = "select encode(backups.release_part($1, 0), 'hex') as key";

/** The part-read receipts, as login and part. */
const partReads = async (): Promise<{ actor: string; part: number }[]> => [
  ...(await store.admin.execute<{ actor: string; part: number }>(
    "select actor, part from backups.receipts where action = 'backup read' and part is not null order by id",
  )),
];

/** The newest archive's id, its header read (and logged) as `reader`, the operator `person`. */
async function header(reader: Client, person: string = operator): Promise<string> {
  const { rows } = await reader.query<{ id: string }>(
    'select id from backups.read_latest($1, $2)',
    [person, OPERATING_BUSINESS],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no archive');
  return id;
}

/** Part 0 of `id` as `reader` reads it: the store's digest and what it hands out. */
async function readPart(reader: Client, id: string): Promise<{ digest: string; part: Buffer }> {
  const { rows } = await reader.query<{ part_sha256: string; part: Buffer }>(
    'select part_sha256, part from backups.read_part($1, 0)',
    [id],
  );
  const [row] = rows;
  if (row === undefined) throw new Error('no part');
  return { digest: row.part_sha256, part: row.part };
}

/** `sealed` opened with a key `release_part` handed out (AES-256-CBC, a zero IV: each key seals one part once). */
const open = (sealed: Buffer, key: string): Buffer => {
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.alloc(16));
  return Buffer.concat([decipher.update(sealed), decipher.final()]);
};

const body = randomBytes(1000);
// The person the installation appointed the second operator's login as.
const secondPerson = '00000000-0000-4000-8000-0000000000b2';
let second: { url: string; name: string };
let reader: Client;

describe.skipIf(serverUrl === undefined)('a part key released once, after the read', () => {
  backupStoreHooks();
  beforeAll(async () => {
    const writer = await asRole(backupLogin.url, BACKUP);
    try {
      await addArchive(writer, body);
    } finally {
      await writer.end();
    }
    // A second operator the installation appointed, as another person.
    second = await loginIn(store, RESTORE, 'o2');
    await store.admin.execute('insert into backups.appointed (login, person) values ($1, $2)', [
      second.name,
      secondPerson,
    ]);
    reader = await asRole(operatorLogin.url, RESTORE);
  });
  afterAll(async () => {
    await reader?.end();
    await store.admin.execute('delete from backups.appointed where login = $1', [second?.name]);
    await store.admin.execute(`drop owned by "${second?.name}"`);
    await store.admin.execute(`drop role if exists "${second?.name}"`);
  });

  releaseOpensTheRead();
  releasedOnce();
  releasedOnlyToItsReader();
  appointmentEndsTheRelease();
  releaseRefusedInAnOldSnapshot();
  keyLife();
});

function releaseOpensTheRead() {
  it('a read hands out sealed bytes and no receipt; the release opens them and writes one', async () => {
    const id = await header(reader);
    const before = await partReads();
    const { digest, part } = await readPart(reader, id);
    expect({ sealed: !part.equals(body), receipts: await partReads() }).toEqual({
      sealed: true,
      receipts: before,
    });
    const { rows } = await reader.query<{ key: string }>(RELEASE, [id]);
    const opened = open(part, rows[0]?.key ?? '');
    expect({
      opened: opened.equals(body),
      digest: createHash('sha256').update(opened).digest('hex') === digest,
      receipts: (await partReads()).slice(before.length),
    }).toEqual({ opened: true, digest: true, receipts: [{ actor: operatorLogin.name, part: 0 }] });
  });
}

function releasedOnce() {
  it('a key is released once, even to a caller that rolls back', async () => {
    const id = await header(reader);
    await readPart(reader, id);
    // `attempt` rolls its transaction back: the release stands all the same.
    expect(await attempt(reader, RELEASE, [id])).toBe('ok');
    const before = await partReads();
    expect(await attempt(reader, RELEASE, [id])).toBe('42501');
    expect(await partReads()).toEqual(before);
  });
}

function releasedOnlyToItsReader() {
  it('no key is released for a part this login did not read', async () => {
    const id = await header(reader);
    await readPart(reader, id);
    const other = await asRole(second.url, RESTORE);
    const unappointed = await asRole(restoreLogin.url, RESTORE);
    const job = await asRole(backupLogin.url, BACKUP);
    try {
      // The other operator reads the header as its own person, as the store requires.
      await header(other, secondPerson);
      const before = await partReads();
      expect({
        anotherOperator: await attempt(other, RELEASE, [id]),
        unappointed: await attempt(unappointed, RELEASE, [id]),
        backupIdentity: await attempt(job, RELEASE, [id]),
        receipts: await partReads(),
      }).toEqual({
        anotherOperator: '42501',
        unappointed: '42501',
        backupIdentity: '42501',
        receipts: before,
      });
      // The reader's own key is still its own to release.
      expect(await attempt(reader, RELEASE, [id])).toBe('ok');
    } finally {
      await Promise.all([other.end(), unappointed.end(), job.end()]);
    }
  });
}

function appointmentEndsTheRelease() {
  it('an appointment removed between the read and the release ends it, with no receipt', async () => {
    const id = await header(reader);
    await readPart(reader, id);
    const before = await partReads();
    await store.admin.execute('delete from backups.appointed where login = $1', [
      operatorLogin.name,
    ]);
    try {
      expect(await attempt(reader, RELEASE, [id])).toBe('42501');
      expect(await partReads()).toEqual(before);
    } finally {
      await store.admin.execute('insert into backups.appointed (login, person) values ($1, $2)', [
        operatorLogin.name,
        operator,
      ]);
    }
  });
}

function releaseRefusedInAnOldSnapshot() {
  it('a release in a repeatable-read transaction is refused', async () => {
    const id = await header(reader);
    await readPart(reader, id);
    await reader.query('begin isolation level repeatable read');
    let code = 'ok';
    try {
      await reader.query(RELEASE, [id]);
    } catch (error) {
      code = (error as { code?: string }).code ?? 'unknown';
    } finally {
      await reader.query('rollback');
    }
    expect(code).toBe('42501');
  });
}

function keyLife() {
  it('a key not released within its life is refused', async () => {
    const id = await header(reader);
    await readPart(reader, id);
    await store.admin.execute(
      "update backups.part_keys set issued_at = issued_at - interval '1 hour' where login = $1",
      [operatorLogin.name],
    );
    expect(await attempt(reader, RELEASE, [id])).toBe('42501');
  });
}
