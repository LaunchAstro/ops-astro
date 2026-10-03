// SPDX-License-Identifier: AGPL-3.0-only
//
// The store drill (`restore-drill.mjs --drill`) asks the operator gate again
// as it reads, as the export does (OW-063.2 and OW-066.4, round 2): once the
// operator's `operations:manage` is revoked, it reads no part of the archive
// and takes nothing more to the store, so no receipt is written in their name.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keys } from './carried-archive.fixture.ts';
import { scratch } from './operator-only-commands.fixture.ts';
import {
  operatorOnlyHooks,
  serverUrl,
  subjects,
  type OperatorOnlyState,
} from './operator-only.fixture.ts';
import {
  load,
  plantedStore,
  signedIn,
  type DrillCommand,
  type Reach,
  type Seal,
} from './s0-3e-operating-business.fixture.ts';

// Without a database the fixture has nothing to build, as in operator-only-acts.test.ts.
describe.skipIf(serverUrl === undefined)('the store drill asks the gate again', () => {
  let state: OperatorOnlyState;
  operatorOnlyHooks((shared) => {
    state = shared;
  });

  const revoke = async (): Promise<void> => {
    await state.db.admin.execute(
      "update public.grants set revoked_at = now() where subject_id = $1 and collection = 'operations' and action = 'manage'",
      [state.operatorPerson],
    );
  };

  it('a store drill reads no part and records nothing once operations:manage is revoked', async () => {
    const { sealArchive } = await load<Seal>('../../scripts/ops/archive-seal.mjs');
    const store = plantedStore(sealArchive(Buffer.from('synthetic drill record'), keys.publicKey));
    const folder = mkdtempSync(join(scratch, 'drill-again-'));
    const keyFile = join(folder, 'restore.key');
    writeFileSync(keyFile, keys.privateKey, { mode: 0o600 });
    const { env } = await signedIn(subjects.operator, 'alpha');
    const { runDrillCommand } = await load<DrillCommand>('../../scripts/ops/restore-drill.mjs');
    let revoked = false;
    const afterRevocation: string[] = [];
    const reach: Reach = async (url, script, onLine) => {
      if (revoked) afterRevocation.push(onLine === undefined ? 'statement' : 'parts');
      const answer = await store.reach(url, script, onLine);
      if (!revoked) {
        // The header is read; the operator's key goes before any part is asked for.
        await revoke();
        revoked = true;
      }
      return answer;
    };
    const outcome = await runDrillCommand(['--drill'], {
      environment: {
        ...env,
        RESTORE_KEY_FILE: keyFile,
        DRILL_BUSINESS_ID: randomUUID(),
        DRILL_CLIENT_ID: randomUUID(),
        DRILL_PERSON_ID: randomUUID(),
      },
      reach,
    }).then(
      (run) => run.receipt?.['outcome'],
      () => 'stopped',
    );
    expect(revoked).toBe(true);
    expect({ afterRevocation, outcome }).toEqual({ afterRevocation: [], outcome: 'stopped' });
  });
});
