// SPDX-License-Identifier: AGPL-3.0-only
//
// C31: `expectedRevision: 0` on secret.set means "this name must not exist
// yet". A first set from a screen whose list did not hold the name sends it, so
// a key another administrator created after that list was read is refused
// VERSION_STALE instead of silently replaced (SEC-374-R3 M1).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSealingPair } from '../../packages/core-records/src/custody/index.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Stored {
  readonly revision: string;
  readonly set_by_actor_id: string;
  readonly sealed: string;
}

// eslint-disable-next-line max-lines-per-function -- one world, one case over it
describe.skipIf(serverUrl === undefined)('C31 secret.set expect absent', () => {
  const pair = generateSealingPair('test/c31-absent@1');
  let controls: Controls;

  beforeAll(async () => {
    controls = await createControls('absent373', { custody: pair.key });
    await controls.fixture.db.app.withBusiness(controls.fixture.business, async (tx) => {
      for (const member of [controls.manager, controls.reader]) {
        // eslint-disable-next-line no-await-in-loop -- two grants in one transaction
        await grantTo(tx, member, 'manage', { kind: 'business', id: null }, false, 'custody');
      }
    });
  });

  afterAll(async () => {
    await controls?.drop();
  });

  const stored = async (name: string): Promise<readonly Stored[]> =>
    await controls.fixture.db.admin.execute<Stored>(
      `select revision, set_by_actor_id, encode(sealed, 'hex') as sealed
         from public.custody_secrets where business_id = $1 and name = $2`,
      [controls.fixture.business, name],
    );

  it('expectedRevision 0 sets a free name at revision 1 and refuses one another caller created', async () => {
    const free = `absent.free-${randomUUID().slice(0, 8)}`;
    const first = await controls.asPerson('secret.set', {
      name: free,
      value: 'absent-free-value',
      expectedRevision: 0,
    });
    expect(first.status, `a free name: ${JSON.stringify(first.body)}`).toBe(200);
    expect(first.body['revision']).toBe(1);

    // The other administrator creates the name after this caller's list was read.
    const taken = `absent.taken-${randomUUID().slice(0, 8)}`;
    const other = await controls.asPerson(
      'secret.set',
      { name: taken, value: 'other-admin-value' },
      controls.reader,
    );
    expect(other.status, `the other administrator's set: ${JSON.stringify(other.body)}`).toBe(200);
    const before = await stored(taken);

    const operationId = randomUUID();
    const late = await controls.asPerson('secret.set', {
      operationId,
      name: taken,
      value: 'late-absent-value',
      expectedRevision: 0,
    });
    expect(late.status, `a taken name: ${JSON.stringify(late.body)}`).toBe(409);
    expect(late.body['code']).toBe('VERSION_STALE');
    expect(JSON.stringify(late.body)).toContain('revision=1');
    expect(JSON.stringify(late.body)).not.toContain('late-absent-value');
    const after = await stored(taken);
    expect(after).toStrictEqual(before);
    expect(after[0]?.revision).toBe('1');
    expect(after[0]?.set_by_actor_id).toBe(controls.reader.actorId);
    const audit = await controls.fixture.db.admin.execute<{ readonly attempted: unknown }>(
      'select attempted from public.audit_events where business_id = $1 and operation_id = $2',
      [controls.fixture.business, operationId],
    );
    expect(audit.map((row) => row.attempted)).toStrictEqual([null]);
  });
});
