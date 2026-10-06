// SPDX-License-Identifier: AGPL-3.0-only
//
// A secret that is no live credential holds no lock: it is screened unlocked
// before the access lock a live credential's call takes (#784). So while an
// access change holds the business's access lock, a made-up secret is
// answered at once, and never waits behind the change or holds it up. The
// screen only screens: a credential revoked after it, before the call's
// locks, is refused by the read under them and writes nothing.

import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCredentialCommand } from '../../packages/core-commands/src/commands/credential-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { lockAccess } from '../../packages/core-records/src/authority/access.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { enrol, grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';

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

/** A credential for task read and write, issued by a person who holds both: its secret and id. */
async function issuedBy(world: World) {
  const issuer = await enrol(world.db.app, world.alpha, `screen-${randomUUID().slice(0, 6)}`);
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await grantTo(tx, issuer, 'read', WHOLE_BUSINESS);
    await grantTo(tx, issuer, 'write', WHOLE_BUSINESS);
    await grantTo(tx, issuer, 'write', WHOLE_BUSINESS, false, 'credential');
  });
  const answer = await executeCommand(world.db.app, world.alpha, issuer.presented, 'api', {
    command: 'credential.issue',
    operationId: randomUUID(),
    scope: [
      { collection: 'task', action: 'read' },
      { collection: 'task', action: 'write' },
    ],
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    purpose: 'the command line on a laptop',
  });
  expect(isCommandRefusal(answer), JSON.stringify(answer)).toBe(false);
  const detail = (answer as { readonly detail: Record<string, unknown> }).detail;
  return {
    issuer,
    secret: String(detail['credential']),
    credentialId: String(detail['credentialId']),
  };
}

/** A connection of its own, held once at its first shared access-lock request. */
function heldAtTheSharedLock(world: World, pool: Database, reached: () => void, go: Promise<void>) {
  let held = false;
  const key = `access:${world.alpha}`;
  const paused: Database = {
    log: pool.log,
    close: async () => await pool.close(),
    withBusiness: async (businessId, run) =>
      await pool.withBusiness(
        businessId,
        async (tx) =>
          await run({
            ...tx,
            query: async (sql, parameters = []) => {
              if (!held && sql.includes('pg_advisory_xact_lock_shared') && parameters[0] === key) {
                held = true;
                reached();
                await go;
              }
              return await tx.query(sql, parameters);
            },
          }),
      ),
  };
  return paused;
}

it('a credential revoked after the screen and before its locks is refused and writes nothing', async () => {
  const world = await createWorld('credscreenrevoke');
  const { issuer, secret, credentialId } = await issuedBy(world);
  let reached = noop;
  const atLock = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let go = noop;
  const going = new Promise<void>((resolve) => {
    go = resolve;
  });
  const callerDb = heldAtTheSharedLock(world, connect(world.db.appUrl, { max: 1 }), reached, going);
  const revokerDb = connect(world.db.appUrl, { max: 1 });
  const tasks = async (): Promise<string | undefined> =>
    (
      await world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.records where business_id = $1',
        [world.alpha],
      )
    )[0]?.n;
  try {
    const before = await tasks();
    const answer = executeCredentialCommand(
      callerDb,
      world.alpha,
      { credential: secret, now: new Date() },
      { command: 'task.create', operationId: randomUUID(), fields: { title: 'never written' } },
    );
    await atLock;
    const revoked = await executeCommand(revokerDb, world.alpha, issuer.presented, 'api', {
      command: 'credential.revoke',
      operationId: randomUUID(),
      credentialId,
    });
    expect(isCommandRefusal(revoked), JSON.stringify(revoked)).toBe(false);
    go();
    const refused = await answer;
    expect(isCommandRefusal(refused) ? refused.code : 'served').toBe('DELEGATION_NOT_LIVE');
    expect(await tasks()).toBe(before);
  } finally {
    go();
    await Promise.all([callerDb.close(), revokerDb.close()]);
    await world.close();
  }
});
