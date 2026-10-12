// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { endPersonAuthority } from '../../packages/core-commands/src/commands/authority-controls.ts';
import { lockAccess } from '../../packages/core-records/src/authority/access.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { readBusinessSetting } from '../../packages/core-records/src/records/business-settings.ts';
import { enrol, grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { harness, openWorld } from '../api/api-2-agent-credential-world.ts';
import { blockedBefore, holdRow, instantOf, waitPast } from '../support/lock-wait-race.ts';

openWorld();

it('a money step-up expiring during the setting row wait cannot change the threshold', async () => {
  const { db, alpha } = harness.world;
  const owner = await enrol(db.app, alpha, `money wait ${randomUUID()}`);
  await db.app.withBusiness(alpha, (tx) =>
    grantTo(tx, owner, 'decide', WHOLE_BUSINESS, false, 'spend'),
  );
  const before = await db.app.withBusiness(alpha, (tx) =>
    readBusinessSetting(tx, 'four_eyes_threshold'),
  );
  const [clock] = await db.admin.execute<{ now: number }>(
    'select floor(extract(epoch from clock_timestamp()))::float8 as now',
  );
  if (clock === undefined) throw new Error('no clock');
  const factorAt = clock.now - 3600 + 2;
  const expiry = await instantOf(db, 'select to_timestamp($1::float8)::text as at', [
    factorAt + 3601,
  ]);
  const held = await holdRow(
    db,
    'select id from public.business_settings where business_id = $1 and key = $2 for update',
    [alpha, 'four_eyes_threshold'],
  );
  const sent = executeCommand(
    db.app,
    alpha,
    { ...owner.presented, assurance: { level: 'aal2', signedInAt: clock.now, factorAt } },
    'api',
    { command: 'settings.set_four_eyes_threshold', operationId: randomUUID(), value: 127 },
  );
  sent.catch(() => null);
  try {
    expect(await blockedBefore(db, held, expiry)).toBe(true);
    await waitPast(db, expiry);
  } finally {
    await held.letGo();
  }
  const answer = await sent;
  const after = await db.app.withBusiness(alpha, (tx) =>
    readBusinessSetting(tx, 'four_eyes_threshold'),
  );
  expect({ code: isCommandRefusal(answer) ? answer.code : 'applied', value: after?.value }).toEqual(
    { code: 'STEP_UP_REQUIRED', value: before?.value },
  );
}, 30000);

it('access end does not revoke or count a delegation that expires during its classification lock wait', async () => {
  const { db, alpha, mia, ada, agent } = harness.world;
  const minted = await db.app.withBusiness(alpha, (tx) =>
    mintDelegation(tx, {
      agentActorId: String(agent.actorId),
      delegatePersonId: String(mia.personId),
      mintedByActorId: String(mia.actorId),
      purpose: `end_wait_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['write'],
      purposeScope: { kind: 'record', id: harness.alphaTask.id },
      expiresAt: new Date(Date.now() + 4000),
    }),
  );
  if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
  const id = minted.value.delegation.id;
  const expiry = await instantOf(
    db,
    'select expires_at::text as at from public.delegations where id = $1',
    [id],
  );
  const held = await holdRow(db, 'select id from public.delegations where id = $1 for update', [
    id,
  ]);
  const sent = db.app.withBusiness(alpha, async (tx) => {
    await lockAccess(tx);
    return await endPersonAuthority(tx, String(mia.personId), String(ada.actorId));
  });
  sent.catch(() => null);
  try {
    expect(await blockedBefore(db, held, expiry)).toBe(true);
    await waitPast(db, expiry);
  } finally {
    await held.letGo();
  }
  const ended = await sent;
  const [row] = await db.admin.execute<{ revoked: boolean }>(
    'select revoked_at is not null as revoked from public.delegations where id = $1',
    [id],
  );
  expect({ counted: ended.delegationsRevoked, revoked: row?.revoked }).toEqual({
    counted: 0,
    revoked: false,
  });
}, 30000);
