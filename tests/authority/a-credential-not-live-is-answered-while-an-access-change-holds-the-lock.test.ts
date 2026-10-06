// SPDX-License-Identifier: AGPL-3.0-only
//
// A secret that is no live credential holds no lock: it is screened unlocked
// before the access lock a live credential's call takes (#784). So while an
// access change holds the business's access lock, a made-up secret is
// answered at once, and never waits behind the change or holds it up.

import { randomBytes } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCredentialCommand } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { lockAccess } from '../../packages/core-records/src/authority/access.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { createWorld, serverUrl } from '../acceptance/world.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

const noop = (): void => undefined;

it('a credential that is not live is answered while an access change holds the access lock', async () => {
  const world = await createWorld('credscreen');
  const holderDb = connect(world.db.appUrl, { max: 1 });
  const callerDb = connect(world.db.appUrl, { max: 1 });
  let letGo = noop;
  const released = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let holding = noop;
  const held = new Promise<void>((resolve) => {
    holding = resolve;
  });
  const holder = holderDb.withBusiness(world.alpha, async (tx) => {
    await lockAccess(tx);
    holding();
    await released;
  });
  try {
    await held;
    const answer = executeCredentialCommand(
      callerDb,
      world.alpha,
      { credential: randomBytes(32).toString('base64url'), now: new Date() },
      { command: 'task.read', operationId: 'not-live-at-the-door', recordId: 'none' },
    );
    const late = new Promise<'waited'>((resolve) => {
      setTimeout(() => resolve('waited'), 3000);
    });
    const first = await Promise.race([answer, late]);
    expect(first === 'waited' ? first : (first as { readonly code: string }).code).toBe(
      'DELEGATION_NOT_LIVE',
    );
  } finally {
    letGo();
    await holder.catch(() => null);
    await Promise.all([holderDb.close(), callerDb.close()]);
    await world.close();
  }
});
