// SPDX-License-Identifier: AGPL-3.0-only
//
// A passed drill is the last tested restore, so the store refuses one that
// leaves out the target's major or the table count (OW-059.2). A CHECK whose
// comparison meets a null reads as unknown and passes, so each field is
// required by name. A store installed before the fix takes the same rule from
// deploy/staging/backup-store-upgrade-1.sql, which can be run more than once.

import { describe, expect, it } from 'vitest';
import {
  RESTORE,
  asRole,
  attempt,
  backupStoreHooks,
  operatorLogin,
  read,
  store,
} from './backup-identity.fixture.ts';
import { call, passed } from './backup-drill-records.fixture.ts';
import { readNew } from './backup-store-drills.fixture.ts';

const TARGET_MAJOR = 6;
const TABLES = 7;

async function refusals(): Promise<{ control: string; targetMajor: string; tables: string }> {
  const reader = await asRole(operatorLogin.url, RESTORE);
  try {
    const [text, values] = call(passed, await readNew(reader));
    const control = await attempt(reader, text, values);
    const [again, valuesAgain] = call(passed, await readNew(reader));
    const targetMajor = await attempt(reader, again, valuesAgain.with(TARGET_MAJOR, null));
    const tables = await attempt(reader, again, valuesAgain.with(TABLES, null));
    return { control, targetMajor, tables };
  } finally {
    await reader.end();
  }
}

describe('a passed drill names its restore', () => {
  backupStoreHooks();

  it('the store refuses a pass with no target major or no table count', async () => {
    expect(await refusals()).toEqual({ control: 'ok', targetMajor: '23514', tables: '23514' });
  });

  it('a store made before the rule takes it from the upgrade, run twice', async () => {
    await store.admin.execute(
      'alter table backups.drills drop constraint drills_pass_names_its_restore',
    );
    await store.admin.execute(read('deploy/staging/backup-store-upgrade-1.sql'));
    await store.admin.execute(read('deploy/staging/backup-store-upgrade-1.sql'));
    expect(await refusals()).toEqual({ control: 'ok', targetMajor: '23514', tables: '23514' });
  });
});
