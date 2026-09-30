// SPDX-License-Identifier: AGPL-3.0-only
//
// PICKUP-REPLAY proof group 4 and the legacy limit (group 5, the derivation,
// is in pickup-credential-derivation.test.ts).
//
// The keyring is custody: rotation keeps old read keys, a missing or wrong key
// fails closed without touching the receipt, provisioning never regenerates,
// and a delegation's scheme and key id cannot be rewritten after minting.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  ACTIVE_KEY_VARIABLE,
  configuredCredentialKeys,
  KEYRING_VARIABLE,
} from '../../packages/core-records/src/authority/credential-keys.ts';
import { digestOf } from '../../packages/core-records/src/authority/delegations.ts';
import { detailOf, replayWorld, type Approver, type ReplayWorld } from './pickup-replay-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

const key = (): string => randomBytes(32).toString('base64url');

let restart = (): void => undefined;

function useKeys(active: string, ring: string): void {
  process.env[ACTIVE_KEY_VARIABLE] = active;
  process.env[KEYRING_VARIABLE] = ring;
  restart();
}

describe.skipIf(serverUrl === undefined)('the keyring behind replay (group 4)', () => {
  let world: ReplayWorld;
  let approver: Approver;
  const keyA = key();
  const keyB = key();

  beforeAll(async () => {
    world = await replayWorld('prk');
    approver = await world.approver('keys-approver');
    // A deployment rotates its keyring by restarting: a fresh composition, handed the new one.
    restart = () =>
      void (world.api = world.fixture.compose({
        delegation: configuredCredentialKeys(process.env),
      }));
  }, 120_000);

  afterEach(() => {
    delete process.env[ACTIVE_KEY_VARIABLE];
    delete process.env[KEYRING_VARIABLE];
  });

  afterAll(async () => {
    await world?.fixture.drop();
  });

  const receipt = async (operationId: unknown): Promise<string | null> =>
    await world.scalar(`select result::text as v from public.operations where operation_id = $1`, [
      operationId,
    ]);

  it('keeps replaying under a retained key after rotation, and fails closed without it', async () => {
    useKeys('test/a@1', `test/a@1:${keyA}`);
    const underA = await world.pickUp(approver, 'keys_under_a');
    const delegationA = detailOf(underA.lost)['delegationId'];
    expect(
      await world.scalar(`select credential_key_id as v from public.delegations where id = $1`, [
        delegationA,
      ]),
    ).toBe('test/a@1');

    // Rotate: B is active, A is kept for reading.
    useKeys('test/b@1', `test/a@1:${keyA},test/b@1:${keyB}`);
    const underB = await world.pickUp(approver, 'keys_under_b');
    expect(
      await world.scalar(`select credential_key_id as v from public.delegations where id = $1`, [
        detailOf(underB.lost)['delegationId'],
      ]),
    ).toBe('test/b@1');
    expect(detailOf(await world.asAgent('task.pickup', underA.body))['credential']).toBe(
      underA.credential,
    );

    // Remove A: a closed failure, with the receipt and the rows untouched.
    const stored = await receipt(underA.body['operationId']);
    const hash = await world.scalar(
      `select credential_hash as v from public.delegations where id = $1`,
      [delegationA],
    );
    useKeys('test/b@1', `test/b@1:${keyB}`);
    const without = await world.asAgent('task.pickup', underA.body);
    expect(without.body['code']).toBe('DEPENDENCY_NOT_LANDED');
    expect(JSON.stringify(without.body)).toContain('delegation credential key test/a@1');
    expect(JSON.stringify(without.body)).not.toContain(underA.credential);
    expect(await receipt(underA.body['operationId'])).toBe(stored);
    expect(
      await world.scalar(`select credential_hash as v from public.delegations where id = $1`, [
        delegationA,
      ]),
    ).toBe(hash);
    expect(await world.counts(underA.taskId)).toStrictEqual({
      leases: 1,
      delegations: 1,
      reservations: 1,
      attempts: 1,
    });

    // Restore A: the same credential, with no rotation having happened.
    useKeys('test/b@1', `test/a@1:${keyA},test/b@1:${keyB}`);
    expect(detailOf(await world.asAgent('task.pickup', underA.body))['credential']).toBe(
      underA.credential,
    );
    expect(digestOf(underA.credential)).toBe(hash);
  });

  it('fails closed on corrupted metadata, and the trigger forbids writing it', async () => {
    useKeys('test/a@1', `test/a@1:${keyA},test/b@1:${keyB}`);
    const picked = await world.pickUp(approver, 'keys_corrupt');
    const delegationId = String(detailOf(picked.lost)['delegationId']);

    // The application role cannot move the key id, the scheme or the digest.
    for (const assignment of [
      `credential_key_id = 'test/b@1'`,
      `credential_scheme = 'legacy-random', credential_key_id = null`,
      `credential_hash = repeat('0', 64)`,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        world.fixture.db.app.withBusiness(world.fixture.business, async (tx) => {
          await tx.query(`update public.delegations set ${assignment} where id = $1`, [
            delegationId,
          ]);
        }),
      ).rejects.toThrow(/fixed at mint/u);
    }

    // Past the trigger, as a person with the database could: a held key under
    // the wrong id derives a token whose digest does not match.
    const stored = await receipt(picked.body['operationId']);
    await world.fixture.db.admin.execute(
      `alter table public.delegations disable trigger delegations_credential_is_fixed`,
    );
    await world.fixture.db.admin.execute(
      `update public.delegations set credential_key_id = 'test/b@1' where id = '${delegationId}'`,
    );
    const corrupt = await world.asAgent('task.pickup', picked.body);
    expect(corrupt.body['code']).toBe('DEPENDENCY_NOT_LANDED');
    expect(JSON.stringify(corrupt.body)).toContain('delegation credential integrity');
    expect(JSON.stringify(corrupt.body)).not.toContain(picked.credential);
    expect(await receipt(picked.body['operationId'])).toBe(stored);

    await world.fixture.db.admin.execute(
      `update public.delegations set credential_key_id = 'test/a@1' where id = '${delegationId}'`,
    );
    await world.fixture.db.admin.execute(
      `alter table public.delegations enable trigger delegations_credential_is_fixed`,
    );
    expect(detailOf(await world.asAgent('task.pickup', picked.body))['credential']).toBe(
      picked.credential,
    );
  });

  it('refuses a pickup outright when there is no usable key, and claims nothing', async () => {
    useKeys('test/a@1', `test/a@1:${randomBytes(8).toString('base64url')}`);
    const { taskId, reservationId } = await world.approved(approver, 'keys_missing');
    const answer = await world.asAgent('task.pickup', { operationId: randomUUID(), reservationId });
    expect(answer.body['code']).toBe('DEPENDENCY_NOT_LANDED');
    expect((await world.counts(taskId)).leases).toBe(0);
    expect((await world.counts(taskId)).delegations).toBe(0);
  });

  it('keeps a legacy row legacy: its token works, and its replay says why it has none', async () => {
    useKeys('test/a@1', `test/a@1:${keyA}`);
    const picked = await world.pickUp(approver, 'keys_legacy');
    const delegationId = String(detailOf(picked.lost)['delegationId']);
    // A row as the migration left every pre-existing delegation: random, no key id.
    await world.fixture.db.admin.execute(
      `alter table public.delegations disable trigger delegations_credential_is_fixed`,
    );
    await world.fixture.db.admin.execute(
      `update public.delegations set credential_scheme = 'legacy-random', credential_key_id = null
        where id = '${delegationId}'`,
    );
    await world.fixture.db.admin.execute(
      `alter table public.delegations enable trigger delegations_credential_is_fixed`,
    );

    const replayed = detailOf(await world.asAgent('task.pickup', picked.body));
    expect(replayed['credential']).toBeNull();
    expect(replayed['credentialNote']).toBe('CREDENTIAL_NOT_REPLAYED');
    expect(replayed['leaseId']).toBe(detailOf(picked.lost)['leaseId']);

    // The token its holder already has still works.
    const comment = await world.asAgent(
      'task.comment',
      {
        operationId: randomUUID(),
        recordId: picked.taskId,
        body: 'a legacy holder still at work',
        audience: 'internal',
      },
      picked.credential,
    );
    expect(comment.status, JSON.stringify(comment.body)).toBe(200);

    // And nothing may relabel it derivable.
    await expect(
      world.fixture.db.app.withBusiness(world.fixture.business, async (tx) => {
        await tx.query(
          `update public.delegations
              set credential_scheme = 'hmac-sha256-v1', credential_key_id = 'test/a@1'
            where id = $1`,
          [delegationId],
        );
      }),
    ).rejects.toThrow(/fixed at mint/u);
  });
});
