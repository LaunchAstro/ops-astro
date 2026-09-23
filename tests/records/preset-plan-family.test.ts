// SPDX-License-Identifier: AGPL-3.0-only
//
// Findings 3 and 5 on `preset.plan`.
//
// **Finding 3, the authority is the family's.** The accepted clause is
// "existing collection-manager/manage authority bounded to the owned record
// family", with "no new role power" beside it. The planner checked `manage` on
// a collection called `preset` at business scope, independently of
// `request.recordTypeKey`: the legitimate manager of the task family was
// refused without a new blanket grant, and a holder of that blanket grant could
// plan against every installed type. Both halves are asserted here with **one
// manager identity**, so the difference is the family and nothing else.
//
// The negative is a second record type this person does not manage. Issuing
// business-wide preset authority to make the positive pass would be the "new
// role power" the clause forbids, so nothing here does that.
//
// **Finding 5, duplicate new keys refuse.** `byKey` held the installed fields
// and was never updated as the plan grew, so two entries with one new key both
// became creates — different slots for a slotted pair, two unslotted creates
// for a JSON pair — and the planner returned success although
// `field_defs_key_idx` permits one key per business and type. A validated dry
// run that promises what the apply cannot do is the thing D05 says it may not
// be. Both shapes are covered, each asserting the refusal by name, zero actions
// and an unchanged database.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { planPresetSync } from '../../packages/core-records/src/records/preset-plan.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A classified field, so nothing here is refused for the reason D05 already covers. */
const field = (key: string, valueType: 'text' | 'json' = 'text') => ({
  key,
  label: key,
  valueType,
  writeMode: 'generic',
});

describe.skipIf(serverUrl === undefined)('preset.plan is bounded to the owned family', () => {
  let db: FreshDatabase;
  let business: string;
  let personId: string;
  let actorId: string;

  const countFields = async (): Promise<number> =>
    await db.app.withBusiness(business, async (tx) => {
      const rows = await tx.query<{ readonly n: string }>(
        `select count(*)::text as n from field_defs where business_id = $1`,
        [business],
      );
      return Number(rows[0]?.n ?? '-1');
    });

  const plan = async (recordTypeKey: string, fields: readonly unknown[]) =>
    await db.app.withBusiness(business, async (tx) =>
      planPresetSync(
        tx,
        { personId, actorId },
        { recordTypeKey, presetKey: 'agency', fields: fields as never },
      ),
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l2f' });
    business = await insertBusiness(db.app, 'families');
    await db.app.withBusiness(business, async (tx) => {
      personId = await insertPerson(tx, 'Ada');
      actorId = await insertActor(tx, personId);
      await installTaskSpine(tx);

      // A second installed type, so "a different family" is a real family and
      // not an unknown key: the refusal has to be about authority.
      await tx.query(
        `insert into record_types (business_id, id, key, name, origin, retention_class)
         values ($1, $2, 'invoice', 'Invoice', 'preset', 'work')`,
        [business, randomUUID()],
      );

      // The one grant this person holds: manage on the task family. Not
      // `preset`, and not business-wide over everything.
      const issued = await issueGrant(tx, [{ kind: 'person', id: personId }], {
        subject: { kind: 'person', id: personId },
        scope: { kind: 'business', id: null },
        collection: 'task',
        action: 'manage',
        parentGrantId: null,
        grantedByActorId: actorId,
      });
      if (!issued.ok) throw new Error(`fixture: ${issued.refusal.code}`);
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('plans the family the manager owns', async () => {
    const result = await plan('task', [field('client_reference')]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actions).toStrictEqual([
      { action: 'create_field', key: 'client_reference', slot: expect.any(String) },
    ]);
  });

  it('refuses the same manager on a family they do not own', async () => {
    const result = await plan('invoice', [field('client_reference')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('SCOPE_NOT_GRANTED');
    // The refusal names the family it wanted, so a caller knows what to ask for.
    expect(result.refusal.names).toStrictEqual(['invoice']);
  });

  it('refuses duplicate slotted keys with no actions and no writes', async () => {
    const before = await countFields();
    const result = await plan('task', [
      field('client_reference'),
      field('purchase_order'),
      field('client_reference'),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('PRESET_FIELD_DUPLICATE');
    expect(result.refusal.names).toStrictEqual(['client_reference']);
    expect(await countFields()).toBe(before);
  });

  it('refuses duplicate unslotted keys with no actions and no writes', async () => {
    const before = await countFields();
    const result = await plan('task', [field('payload', 'json'), field('payload', 'json')]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('PRESET_FIELD_DUPLICATE');
    expect(result.refusal.names).toStrictEqual(['payload']);
    expect(await countFields()).toBe(before);
  });

  it('keeps an installed field distinct from a conflicting requested one', async () => {
    // `title` is installed, so one entry naming it is `no_change` rather than a
    // duplicate. The distinction the finding asks to retain.
    const single = await plan('task', [field('title')]);
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(single.value.actions).toStrictEqual([{ action: 'no_change', key: 'title' }]);

    // Two entries naming it are still a duplicate request, installed or not.
    const twice = await plan('task', [field('title'), field('title')]);
    expect(twice.ok).toBe(false);
    if (twice.ok) return;
    expect(twice.refusal.code).toBe('PRESET_FIELD_DUPLICATE');
  });
});
