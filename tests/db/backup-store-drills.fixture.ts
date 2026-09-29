// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-3d drill receipt suite's longer parts (backup-store-drills.test.ts):
// a new archive read by a login, as a pass on the machine binds it, and the
// operator receipt case, run through the drill's own act.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  BACKUP,
  keys,
  asRole,
  backupLogin,
  operatorLogin,
  OPERATING_BUSINESS,
  addArchive,
  type Client,
  hostReach,
} from './backup-identity.fixture.ts';
import { operator, passed, failed, type Binding } from './backup-drill-records.fixture.ts';

/** A new archive in the store, read by `client`'s login: what a pass on the machine binds. */
export async function readNew(client: Client): Promise<Binding> {
  const writer = await asRole(backupLogin.url, BACKUP);
  try {
    await addArchive(writer, randomBytes(16));
  } finally {
    await writer.end();
  }
  const { rows } = await client.query<{ id: string; taken_at: Date; sha256: string }>(
    'select id, taken_at, sha256 from backups.read_latest($1, $2)',
    [operator, OPERATING_BUSINESS],
  );
  const [read] = rows;
  return {
    archiveTakenAt: read?.taken_at.toISOString() ?? '',
    business: OPERATING_BUSINESS,
    archiveId: read?.id ?? '',
    sha256: read?.sha256 ?? '',
  };
}

/**
 * The operator receipt case: the drill's own act, a pass and a failure of the
 * newest archive through the appointed operator's login, each receipt with
 * every field and no other, and no key, credential, path or record data.
 */
export async function operatorReceiptCase(): Promise<void> {
  const path = '../../scripts/ops/restore-drill.mjs';
  const drillModule = (await import(/* @vite-ignore */ path)) as {
    drillAsOperator: (options: Record<string, unknown>) => Promise<unknown>;
    RECEIPT_FIELDS: readonly string[];
  };
  const records = mkdtempSync(join(tmpdir(), 's0-3d-'));
  const canary = `canary-${randomBytes(8).toString('hex')}`;
  try {
    const gate = {
      ok: true as const,
      operator: { personId: operator, business: OPERATING_BUSINESS },
      records,
      recordSignIn: async () => {},
    };
    const backup = await asRole(backupLogin.url, BACKUP);
    try {
      await addArchive(backup, randomBytes(16));
    } finally {
      await backup.end();
    }
    for (const [i, outcome] of [passed, failed].entries()) {
      // oxlint-disable-next-line no-await-in-loop
      const receipt = (await drillModule.drillAsOperator({
        gate,
        storeUrl: operatorLogin.url,
        reach: hostReach,
        // The drill fetches the newest archive through the store as the real one does.
        drill: async ({
          fetchArchive,
        }: {
          fetchArchive: (into: string) => Promise<{ takenAt: string }>;
        }) => {
          const fetched = await fetchArchive(join(records, `archive-${String(i)}`));
          return {
            event: 'restore drill',
            at: new Date().toISOString(),
            ...outcome,
            archiveTakenAt: fetched.takenAt,
          };
        },
      })) as Record<string, unknown>;
      expect(Object.keys(receipt).toSorted()).toStrictEqual(
        [...drillModule.RECEIPT_FIELDS].toSorted(),
      );
      expect(receipt).toMatchObject({
        action: 'restore drill recorded',
        outcome: outcome.outcome,
        operator,
        productionMajor: 17,
        targetMajor: 17,
        ranOn: 'staging machine',
      });
      expect(typeof receipt['lastTestedRestore']).toBe('string');
      const text = JSON.stringify(receipt);
      for (const secret of [
        operatorLogin.url,
        operatorLogin.name,
        records,
        keys.privateKey,
        canary,
      ]) {
        expect(text).not.toContain(secret);
      }
      expect(text).not.toMatch(/PRIVATE KEY|postgres:\/\/|\/Users\/|\/tmp\/|sha256/u);
    }
    const kept = readFileSync(join(records, 'deployments.jsonl'), 'utf8').trim().split('\n');
    expect(kept).toHaveLength(2);
    expect(kept.map((line) => (JSON.parse(line) as { action: string }).action)).toStrictEqual([
      'restore drill recorded',
      'restore drill recorded',
    ]);
  } finally {
    rmSync(records, { recursive: true, force: true });
  }
}
