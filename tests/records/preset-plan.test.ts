// SPDX-License-Identifier: AGPL-3.0-only
//
// D05: `preset.plan` is a real dry run over the domain, not a SQL constraint
// wearing a planner's name.
//
// The ledger's negative is exact: relying only on the database's refusal, or
// rejecting every plan, both fail. So there are two halves here. A valid plan
// is accepted and says what it would do. An unclassified field is refused
// before anything is applied — and the proof that "before" is real is that the
// database is unchanged afterwards, with the valid fields of the same plan
// also absent, because a planner that applied the good half and refused the
// bad one is not a dry run.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planPresetSync } from '../../packages/core-records/src/records/preset-plan.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('preset.plan', () => {
  let db: FreshDatabase;
  let business: string;
  let personId: string;
  let actorId: string;
  let manageGrant: string;

  const countFields = async (): Promise<number> =>
    await db.app.withBusiness(business, async (tx) => {
      const rows = await tx.query<{ readonly n: string }>(
        `select count(*)::text as n from field_defs where business_id = $1`,
        [business],
      );
      return Number(rows[0]?.n ?? '-1');
    });

  const plan = async (fields: readonly unknown[]) =>
    await db.app.withBusiness(business, async (tx) =>
      planPresetSync(
        tx,
        { personId, actorId },
        { recordTypeKey: 'task', presetKey: 'agency', fields: fields as never },
      ),
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l2p' });
    business = await insertBusiness(db.app, 'alpha');
    await db.app.withBusiness(business, async (tx) => {
      personId = await insertPerson(tx, 'Ada');
      actorId = await insertActor(tx, personId);
      await installTaskSpine(tx);
      const issued = await issueGrant(tx, [{ kind: 'person', id: personId }], {
        subject: { kind: 'person', id: personId },
        scope: { kind: 'business', id: null },
        // Finding 3: the grant a legitimate planner holds is `manage` on the
        // family being planned, not a blanket `preset` collection.
        collection: 'task',
        action: 'manage',
        parentGrantId: null,
        grantedByActorId: actorId,
      });
      if (!issued.ok) throw new Error(`fixture: ${issued.refusal.code}`);
      manageGrant = issued.value;
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('accepts a valid plan and says what it would do', async () => {
    const before = await countFields();
    const result = await plan([
      {
        key: 'client_reference',
        label: 'Client reference',
        valueType: 'text',
        writeMode: 'generic',
        visibilityClass: 'shared',
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actions).toStrictEqual([
      { action: 'create_field', key: 'client_reference', slot: expect.any(String) },
    ]);
    // A dry run writes nothing, including when it succeeds.
    expect(await countFields()).toBe(before);
  });

  it('refuses an unclassified field, naming it', async () => {
    const result = await plan([{ key: 'unclassified_note', label: 'Note', valueType: 'text' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('PRESET_FIELD_UNCLASSIFIED');
    expect(result.refusal.names).toStrictEqual(['unclassified_note']);
  });

  it('refuses before applying anything, including the valid fields beside it', async () => {
    const before = await countFields();
    const result = await plan([
      {
        key: 'valid_beside_it',
        label: 'Valid',
        valueType: 'text',
        writeMode: 'generic',
        visibilityClass: 'internal',
      },
      { key: 'unclassified_note', label: 'Note', valueType: 'text' },
    ]);
    expect(result.ok).toBe(false);
    expect(await countFields()).toBe(before);
    const survived = await db.app.withBusiness(business, async (tx) =>
      tx.query<{ readonly n: string }>(
        `select count(*)::text as n from field_defs where business_id = $1 and key = $2`,
        [business, 'valid_beside_it'],
      ),
    );
    expect(survived[0]?.n).toBe('0');
  });

  it('refuses a write mode the model does not have, rather than defaulting it open', async () => {
    const result = await plan([
      { key: 'odd_mode', label: 'Odd', valueType: 'text', writeMode: 'sometimes' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('PRESET_FIELD_UNCLASSIFIED');
  });

  it('reports a field that is already installed as no change, not as a clash', async () => {
    const result = await plan([
      { key: 'title', label: 'Title', valueType: 'text', writeMode: 'generic' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actions).toStrictEqual([{ action: 'no_change', key: 'title' }]);
  });

  it('refuses the plan outright without a current manage grant', async () => {
    await db.app.withBusiness(business, async (tx) => {
      await revokeGrant(tx, manageGrant);
    });
    const result = await plan([
      { key: 'later', label: 'Later', valueType: 'text', writeMode: 'generic' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('SCOPE_NOT_GRANTED');
  });
});
