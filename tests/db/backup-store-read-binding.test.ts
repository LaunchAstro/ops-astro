// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3 (REV158S2 criteria 12 and 13, REV158S3 criterion 13): Sol's proofs,
// named by what they prove. Every part the store hands out leaves a receipt; a
// read of one archive never attests another taken in the same transaction, at
// the same time; and a pass on the machine is the appointed operator's own
// act, never the restore identity's alone.

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  serverUrl,
  BACKUP,
  RESTORE,
  asRole,
  attempt,
  backupLogin,
  restoreLogin,
  operatorLogin,
  OPERATING_BUSINESS,
  backupStoreHooks,
  store,
  addArchive,
} from './backup-identity.fixture.ts';
import { operator } from './backup-drill-records.fixture.ts';

const countReadReceipts = async (): Promise<number> => {
  const [row] = await store.admin.execute<{ n: number }>(
    "select count(*)::int as n from backups.receipts where action = 'backup read'",
  );
  return row?.n ?? 0;
};

describe.skipIf(serverUrl === undefined)('S0-3 store read binding', () => {
  backupStoreHooks();

  readBindingCases1();

  readBindingCases2();
  readBindingCases3();

  readBindingCases4();
});

function readBindingCases1() {
  it('every successful read_part access writes an access receipt', async () => {
    const writer = await asRole(backupLogin.url, BACKUP);
    try {
      await writer.query('begin');
      await writer.query("select backups.add_part(0, '\\x01')");
      await writer.query("select backups.complete_archive(1, repeat('a', 64))");
      await writer.query('commit');
    } finally {
      await writer.end();
    }
    const reader = await asRole(restoreLogin.url, RESTORE);
    try {
      const { rows } = await reader.query<{ id: string }>('select id from backups.read_latest()');
      const id = rows[0]?.id;
      expect(id).toBeDefined();
      const before = await countReadReceipts();
      await reader.query('select * from backups.read_part($1, 0)', [id]);
      await reader.query('select * from backups.read_part($1, 0)', [id]);
      expect(await countReadReceipts()).toBe(before + 2);
    } finally {
      await reader.end();
    }
  });
}

/** Two archives of one byte each, taken in one transaction, so at one time; answers their digests. */
async function twoInOneTransaction(): Promise<[string, string]> {
  const digests: [string, string] = [
    createHash('sha256')
      .update(Buffer.from([1]))
      .digest('hex'),
    createHash('sha256')
      .update(Buffer.from([2]))
      .digest('hex'),
  ];
  const writer = await asRole(backupLogin.url, BACKUP);
  try {
    await writer.query('begin');
    await writer.query("select backups.add_part(0, '\\x01')");
    await writer.query('select backups.complete_archive(1, $1)', [digests[0]]);
    await writer.query("select backups.add_part(0, '\\x02')");
    await writer.query('select backups.complete_archive(1, $1)', [digests[1]]);
    await writer.query('commit');
  } finally {
    await writer.end();
  }
  return digests;
}

/** A carried pass by the appointed operator of `latest`, the archive read, with `digest`. */
const carriedPass = (latest: { id: string; taken_at: Date } | undefined, digest: string) => [
  'passed',
  null,
  operator,
  latest?.taken_at,
  17,
  17,
  17,
  1,
  { fetch: 1 },
  digest,
  latest?.id,
  OPERATING_BUSINESS,
];

/** An on-machine pass by the appointed operator of `latest`, with `sha` and `business`. */
const machinePass = (latest: { id: string; taken_at: Date }, sha: string, business: string) => [
  'passed',
  null,
  operator,
  latest.taken_at,
  17,
  17,
  17,
  1,
  { fetch: 1 },
  business,
  latest.id,
  sha,
];

/** Through `url`: a pass of the newest archive with its digest is taken only when `allowed`; a wrong digest or business never. */
async function passesOnMachine(url: string, allowed: boolean, digest: string): Promise<void> {
  const call = 'select backups.record_drill($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)';
  const reader = await asRole(url, RESTORE);
  try {
    const { rows } = await reader.query<{ id: string; taken_at: Date }>(
      'select id, taken_at from backups.read_latest()',
    );
    const latest = rows[0] ?? { id: '', taken_at: new Date(0) };
    expect(await attempt(reader, call, machinePass(latest, digest, OPERATING_BUSINESS))).toBe(
      allowed ? 'ok' : '42501',
    );
    expect(
      await attempt(reader, call, machinePass(latest, 'ab'.repeat(32), OPERATING_BUSINESS)),
    ).toBe('42501');
    expect(await attempt(reader, call, machinePass(latest, digest, 'another-business'))).toBe(
      '42501',
    );
  } finally {
    await reader.end();
  }
}

function readBindingCases2() {
  // Sol's REV158S2 proof. Its call named no archive id, which the store
  // requires (REV158S3), so it now names the archive the login read, with
  // the other archive's digest, as the appointed operator, and the same call
  // with the read archive's own digest is taken: the refusal is the binding's.
  it('a read of one same-time archive cannot attest a different archive', async () => {
    const [firstDigest, secondDigest] = await twoInOneTransaction();
    const reader = await asRole(operatorLogin.url, RESTORE);
    try {
      const { rows } = await reader.query<{ id: string; taken_at: Date; sha256: string }>(
        'select id, taken_at, sha256 from backups.read_latest()',
      );
      const latest = rows[0];
      expect(latest).toBeDefined();
      const otherDigest = latest?.sha256 === firstDigest ? secondDigest : firstDigest;
      const call = 'select backups.record_carried_drill($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)';
      const args = (digest: string) => carriedPass(latest, digest);
      const code = await attempt(reader, call, args(otherDigest));
      expect(code).toBe('42501');
      expect(await attempt(reader, call, args(latest?.sha256 ?? ''))).toBe('ok');
      // Without the archive id there is no such call at all.
      expect(
        await attempt(
          reader,
          'select backups.record_carried_drill($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          ['passed', null, operator, latest?.taken_at, 17, 17, 17, 1, { fetch: 1 }, latest?.sha256],
        ),
      ).toBe('42883');
    } finally {
      await reader.end();
    }
  });
}

// Sol's REV158S3 criterion 13 on-machine proof, adapted from "without the
// restored challenge" to "without the verified operator" (ORCH-DECISION
// 22:09Z): the restore challenge is withdrawn, and a pass on the machine is
// the appointed operator's own act. Its setup no longer completes the archive
// with a challenge; its call and assertion are Sol's.
function readBindingCases3() {
  it('an on-machine pass without the verified operator is refused', async () => {
    const writer = await asRole(backupLogin.url, BACKUP);
    try {
      await addArchive(writer, Buffer.from([3]), false);
    } finally {
      await writer.end();
    }
    const reader = await asRole(restoreLogin.url, RESTORE);
    try {
      const { rows } = await reader.query<{ taken_at: Date }>(
        'select taken_at from backups.read_latest()',
      );
      expect(rows[0]).toBeDefined();
      const code = await attempt(
        reader,
        'select backups.record_drill($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        ['passed', null, randomUUID(), rows[0]?.taken_at, 17, 17, 17, 1, { fetch: 1 }],
      );
      expect(code).toBe('42501');
    } finally {
      await reader.end();
    }
  });
}

function readBindingCases4() {
  it('on the machine, the restore identity alone cannot pass even with the business, the archive it read and its digest; the appointed operator can, and only for that archive', async () => {
    const body = Buffer.from([4]);
    const writer = await asRole(backupLogin.url, BACKUP);
    try {
      await addArchive(writer, body, false);
    } finally {
      await writer.end();
    }
    const digest = createHash('sha256').update(body).digest('hex');
    await passesOnMachine(restoreLogin.url, false, digest);
    await passesOnMachine(operatorLogin.url, true, digest);
  });
}
