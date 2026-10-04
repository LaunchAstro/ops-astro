// SPDX-License-Identifier: AGPL-3.0-only
//
// A part read holds no lock a revocation waits on (D1 security review L1): a
// revocation of the operator's `operations:manage` grant, issued once the
// part's bytes have reached the file and before the read has ended, commits
// within a short lock timeout. The gate asks again after the read, so that
// part is refused and the export keeps no file.

import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { operatorOnlyHooks, subjects } from '../ci/operator-only.fixture.ts';
import type { OperatorOnlyState } from '../ci/operator-only.fixture.ts';
import { scratch } from '../ci/operator-only-commands.fixture.ts';
import { keys } from '../ci/carried-archive.fixture.ts';
import {
  load,
  plantedStore,
  signedIn,
  type DrillCommand,
  type Seal,
} from '../ci/s0-3e-operating-business.fixture.ts';

let state: OperatorOnlyState;
operatorOnlyHooks((shared) => {
  state = shared;
});

/** Revokes the operator's grant under a 200 ms lock timeout: 'committed', or the error code. */
async function revoke(): Promise<string> {
  try {
    await state.db.admin.transaction(async (execute) => {
      await execute("set local lock_timeout = '200ms'");
      await execute(
        "update public.grants set revoked_at = now() where subject_id = $1 and collection = 'operations' and action = 'manage'",
        [state.operatorPerson],
      );
    });
    return 'committed';
  } catch (error) {
    return error instanceof Error && 'code' in error ? String(error.code) : 'failed';
  }
}

it('a revocation during a part read commits at once, and that part is refused and removed', async () => {
  const { sealArchive } = await load<Seal>('../../scripts/ops/archive-seal.mjs');
  const store = plantedStore(sealArchive(Buffer.from('made-up client record'), keys.publicKey));
  const file = join(mkdtempSync(join(scratch, 'part-read-revoked-')), 'archive.sealed');
  const { env } = await signedIn(subjects.operator, 'alpha');
  const { runDrillCommand } = await load<DrillCommand>('../../scripts/ops/restore-drill.mjs');
  let [revocation, partWritten] = ['never issued', false];
  const reach: typeof store.reach = async (url, script, onLine) => {
    const answer = await store.reach(url, script, onLine);
    if (onLine !== undefined && revocation === 'never issued') {
      partWritten = statSync(file).size > 0;
      revocation = await revoke();
    }
    return answer;
  };
  const outcome = await runDrillCommand(['--export', file], { environment: env, reach }).then(
    () => 'exported',
    () => 'refused',
  );
  expect({ revocation, partWritten, outcome, kept: existsSync(file) }).toEqual({
    revocation: 'committed',
    partWritten: true,
    outcome: 'refused',
    kept: false,
  });
});
