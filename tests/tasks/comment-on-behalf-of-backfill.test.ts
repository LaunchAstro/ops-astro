// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #414: migration 20261006143500 gives a comment type installed
// before `on_behalf_of` was declared the same field row `installTaskSpine`
// writes now (system-written, internal, no slot), and leaves a type that has
// it alone, as 0075 did for `parent`.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';

const MIGRATION = readFileSync('migrations/20261006143500_comment_on_behalf_of.sql', 'utf8');

// eslint-disable-next-line max-lines-per-function -- one fresh database, the backfill and its guard
describe.skipIf(databaseUrlFromEnvironment() === undefined)('the on_behalf_of backfill', () => {
  let db: FreshDatabase;
  let business: string;
  let commentTypeId: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'obo' });
    business = await insertBusiness(db.app, 'installed-before');
    commentTypeId = await db.app.withBusiness(business, async (tx) => {
      const spine = await installTaskSpine(tx);
      return spine.taskCommentTypeId;
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const rows = async () =>
    await db.admin.execute<Record<string, unknown>>(
      `select slot, write_mode, owning_operation, visibility_class, origin, value_type
         from public.field_defs where record_type_id = $1 and key = 'on_behalf_of'`,
      [commentTypeId],
    );

  it('adds the field row an older comment type lacks, once', async () => {
    const installed = await rows();
    await db.admin.execute(
      `delete from public.field_defs where record_type_id = $1 and key = 'on_behalf_of'`,
      [commentTypeId],
    );
    await db.admin.execute(MIGRATION);
    await db.admin.execute(MIGRATION);
    expect({ installed, backfilled: await rows() }).toEqual({
      installed: [
        {
          slot: null,
          write_mode: 'system',
          owning_operation: null,
          visibility_class: 'internal',
          origin: 'core',
          value_type: 'uuid',
        },
      ],
      backfilled: installed,
    });
  });

  it('refuses, by name, a preset field already holding the key, and adds no core row beside it', async () => {
    await db.admin.execute(
      `update public.field_defs set origin = 'preset'
        where record_type_id = $1 and key = 'on_behalf_of'`,
      [commentTypeId],
    );
    await expect(db.admin.execute(MIGRATION)).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/comment field on_behalf_of is reserved by the core/u),
    });
    expect((await rows()).map((row) => row['origin'])).toStrictEqual(['preset']);
    await db.admin.execute(
      `update public.field_defs set origin = 'core'
        where record_type_id = $1 and key = 'on_behalf_of'`,
      [commentTypeId],
    );
  });
});
