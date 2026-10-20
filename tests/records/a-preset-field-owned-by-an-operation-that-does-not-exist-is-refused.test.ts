// SPDX-License-Identifier: AGPL-3.0-only
//
// A preset field's owning operations are checked against the command
// catalogue, not only spelled as `collection.action`: a well-formed name that
// no operation answers to is refused by the plan, which promises nothing the
// apply could not keep.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;
let ada: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'preset_owning_ops' });
  alpha = await insertBusiness(db.app, 'alpha');
  await installSpine(db.app, alpha);
  ada = await enrol(db.app, alpha, 'Ada Planner');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ada, 'manage');
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const planWith = async (owningOperations: readonly string[]) =>
  await executeRead(db.app, alpha, ada.presented, {
    read: 'preset.plan',
    recordTypeKey: 'task',
    presetKey: 'agency',
    fields: [
      {
        key: 'owned_note',
        label: 'Owned note',
        valueType: 'text',
        writeMode: 'operation',
        owningOperations,
      },
    ],
  } as never);

describe.skipIf(serverUrl === undefined)('preset field owning operations', () => {
  it('a field owned by an operation the catalogue has is planned', async () => {
    expect(await planWith(['task.update'])).toMatchObject({ ok: true });
  });

  it('a field owned by a well-formed operation name nothing answers to is refused by name', async () => {
    expect(await planWith(['task.teleport'])).toMatchObject({
      refused: true,
      code: 'PRESET_FIELD_INVALID',
      names: ['owned_note'],
    });
  });
});
