// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #316: an agent credential's subject is held within the keys its
// person ticked (API-2), so the list helpers answer only those keys, exactly
// as `checkAuthority` does for one record. The two criterion 3 cases are
// Sol's proofs from OW-021 (R/sol/proofs/OW-021-4126931d1.patch), unchanged;
// the third holds `coveredScopes`, the same helper's twin, to the same rule.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { checkAuthority, subjectsOf } from '../../packages/core-records/src/authority/grants.ts';
import { coveredScopes } from '../../packages/core-records/src/authority/covered-scopes.ts';
import {
  readableRecordIds,
  readableScope,
} from '../../packages/core-records/src/authority/readable-scope.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';

let db: FreshDatabase;
let business: string;
let owner: Member;
let taskTypeId: string;
let recordId: string;

beforeAll(async () => {
  db = await createFreshDatabase({ part: 'solow021' });
  business = await insertBusiness(db.app, 'sol-ow021');
  owner = await enrol(db.app, business, 'Sol owner');
  taskTypeId = (await installSpine(db.app, business)).taskTypeId;
  await db.app.withBusiness(business, async (tx) => {
    await installBusinessSettings(tx);
    await grantTo(tx, owner, 'read');
    await grantTo(tx, owner, 'write');
    await grantTo(tx, owner, 'decide');
    await grantTo(tx, owner, 'manage', { kind: 'business', id: null }, false, 'settings');
  });
  const created = await executeCommand(db.app, business, owner.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'Sol scope canary' },
  });
  if ('refused' in created || created.recordId === null) throw new Error('task fixture refused');
  recordId = created.recordId;
}, 120_000);

afterAll(async () => await db?.drop());

it('readableScope cannot give an agent an unticked read key', async () => {
  await db.app.withBusiness(business, async (tx) => {
    const standing = await resolveLogin(tx, owner.presented);
    if ('refused' in standing) throw new Error('owner refused');
    const subjects = subjectsOf({ ...standing, credentialScope: ['task:write'] });
    expect(
      (
        await checkAuthority(tx, subjects, {
          collection: 'task',
          action: 'read',
          scope: { kind: 'record', id: recordId },
        })
      ).ok,
    ).toBe(false);
    expect(await readableScope(tx, subjects, 'task', 'read')).toEqual({
      business: false,
      records: [],
    });
  });
});

it('readableRecordIds cannot give an agent records under an unticked read key', async () => {
  await db.app.withBusiness(business, async (tx) => {
    const standing = await resolveLogin(tx, owner.presented);
    if ('refused' in standing) throw new Error('owner refused');
    const subjects = subjectsOf({ ...standing, credentialScope: ['task:write'] });
    const request = { collection: 'task', action: 'read' as const, recordTypeId: taskTypeId };
    expect(await readableRecordIds(tx, subjectsOf(standing), request)).toContain(recordId);
    expect(await readableRecordIds(tx, subjects, request)).toEqual([]);
  });
});

it('coveredScopes gives an agent no reach under an unticked key, and its ticked key whole', async () => {
  await db.app.withBusiness(business, async (tx) => {
    const standing = await resolveLogin(tx, owner.presented);
    if ('refused' in standing) throw new Error('owner refused');
    const request = { collection: 'task', action: 'decide' as const };
    expect(await coveredScopes(tx, subjectsOf(standing), request)).toEqual({
      business: true,
      records: [],
    });
    const unticked = subjectsOf({ ...standing, credentialScope: ['task:read'] });
    expect(await coveredScopes(tx, unticked, request)).toEqual({ business: false, records: [] });
    const ticked = subjectsOf({ ...standing, credentialScope: ['task:read'] });
    expect(await coveredScopes(tx, ticked, { collection: 'task', action: 'read' })).toEqual({
      business: true,
      records: [],
    });
  });
});
