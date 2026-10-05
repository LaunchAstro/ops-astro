// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync } from 'node:fs';
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

it('revoking operations authority before backup bytes are fetched prevents an archive export', async () => {
  const { sealArchive } = await load<Seal>('../../scripts/ops/archive-seal.mjs');
  const store = plantedStore(sealArchive(Buffer.from('synthetic client record'), keys.publicKey));
  const file = join(mkdtempSync(join(scratch, 'ow066-export-')), 'archive.sealed');
  const { env } = await signedIn(subjects.operator, 'alpha');
  const { runDrillCommand } = await load<DrillCommand>('../../scripts/ops/restore-drill.mjs');
  let revoked = false;
  let bytesFetchedAfterRevocation = false;
  let revocationBlocked = false;
  const reach: typeof store.reach = async (url, script, onLine) => {
    if (!revoked && !revocationBlocked) {
      try {
        await state.db.admin.transaction(async (execute) => {
          await execute("set local lock_timeout = '200ms'");
          await execute(
            "update public.grants set revoked_at = now() where subject_id = $1 and collection = 'operations' and action = 'manage'",
            [state.operatorPerson],
          );
        });
        revoked = true;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === '55P03')) throw error;
        revocationBlocked = true;
      }
    }
    if (onLine !== undefined && revoked) bytesFetchedAfterRevocation = true;
    return await store.reach(url, script, onLine);
  };
  await runDrillCommand(['--export', file], { environment: env, reach }).catch(() => undefined);
  const [grant] = await state.db.admin.execute<{ revoked: boolean }>(
    "select revoked_at is not null as revoked from public.grants where subject_id = $1 and collection='operations' and action='manage'",
    [state.operatorPerson],
  );
  expect(grant?.revoked).toBe(revoked);
  // A guard may serialize the export before revocation by retaining a lock.
  if (revocationBlocked) return;
  expect(revoked, 'the revocation committed before any part was handed out').toBe(true);
  expect
    .soft(
      bytesFetchedAfterRevocation,
      'the export read the whole backup after the authority revocation committed',
    )
    .toBe(false);
  expect(existsSync(file), 'the caller kept an archive after losing operations authority').toBe(
    false,
  );
});
