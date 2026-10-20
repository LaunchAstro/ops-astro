// SPDX-License-Identifier: AGPL-3.0-only
//
// A revert ask under concurrency. The ask locks its correction for update,
// then share-locks the approver setting, then reads its gate grant again at
// the audit chain's lock. Each schedule below holds one of those on a
// connection of its own, starts the other side on another, sees it waiting in
// pg_stat_activity, and then lets go: two asks at once store one; an ask
// behind an approver unset, or behind its correction leaving live, stores
// nothing; an unset behind an ask in flight lands after the ask is stored.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect, writeBusinessSetting } from '../../packages/core-records/src/index.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import { c80World, type C80World } from './c80-world.ts';
import { APPROVER, held, onOwn, waitSeen } from './party-site-races.ts';
import { asksOn, live, revertBody } from './revert-ask-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Revert ask races: DATABASE_URL is unset, so nothing ran.');

let w: C80World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c80World('revertrace');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});
beforeEach(async () => {
  if (serverUrl !== undefined) await w.setApprover(w.ben.personId);
});

/** The approver writer's lock on its setting row. */
const SETTING_WRITE =
  /from business_settings\s+where business_id = \$1 and key = \$2\s+for update/u;
/** The audit chain's lock, the ask's last wait. */
const CHAIN = /pg_advisory_xact_lock/u;

/** Ben's ask on a connection of its own, so two asks never share one. */
async function askOnOwn(correctionId: string): Promise<string> {
  const own = connect(w.world.db.appUrl, { source: 'runtime' });
  try {
    const body = { operationId: randomUUID(), ...revertBody(correctionId) };
    return codeOf(
      await executeCommand(own, w.world.business, w.ben.presented, 'api', body as never),
    );
  } finally {
    await own.close();
  }
}

/**
 * Until a statement waits on a correction's row lock: its backend waits on a
 * lock while holding or asking a tuple lock of `live_corrections`. Read from
 * pg_locks, since the covered read's text is past what pg_stat_activity keeps.
 */
async function waitOnCorrectionSeen(): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    const [row] = await w.world.db.admin.execute<{ readonly waiting: boolean }>(
      `select exists (
         select 1 from pg_stat_activity a
           join pg_locks l on l.pid = a.pid
           join pg_class c on c.oid = l.relation
          where a.datname = current_database() and a.wait_event_type = 'Lock'
            and l.locktype = 'tuple' and c.relname = 'live_corrections') as waiting`,
      [],
    );
    if (row?.waiting === true) return;
    // oxlint-disable-next-line no-await-in-loop -- polling for the waiter
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error('nothing waited on a correction row lock');
}

const unsetApprover = async (tx: TransactionQuery) =>
  await writeBusinessSetting(tx, {
    key: 'live_correction_approver',
    value: null,
    owningOperation: 'settings.set_live_correction_approver',
    actorId: w.admin.actorId,
  });

const holdApprover = async (tx: TransactionQuery) =>
  await tx.query(
    `select 1 from public.business_settings
      where business_id = $1 and key = 'live_correction_approver' for update`,
    [tx.businessId],
  );

const configuredApprover = async (): Promise<unknown> =>
  (
    await w.world.db.admin.execute<{ readonly value: unknown }>(
      `select value from public.business_settings
        where business_id = $1 and key = 'live_correction_approver'`,
      [w.world.business],
    )
  )[0]?.value;

describe.skipIf(serverUrl === undefined)('two revert asks at once', () => {
  it('stores one ask: the second waits on the correction and is refused', async () => {
    const asked = await live(w);
    const blocker = held(w, holdApprover);
    await blocker.ready;
    try {
      const first = askOnOwn(asked.correctionId);
      await waitSeen(w, APPROVER);
      const second = askOnOwn(asked.correctionId);
      await waitOnCorrectionSeen();
      blocker.release();
      const codes = await Promise.all([first, second]);
      expect(codes.toSorted()).toEqual(['GATE_ALREADY_DECIDED', 'not-a-refusal']);
    } finally {
      blocker.release();
      await blocker.done;
    }
    expect((await asksOn(w, asked.correctionId)).length).toBe(1);
  });
});

describe.skipIf(serverUrl === undefined)('a revert ask racing its approver', () => {
  it('stores nothing when it waits behind the approver being unset', async () => {
    const asked = await live(w);
    const unset = held(w, unsetApprover);
    await unset.ready;
    try {
      const asking = askOnOwn(asked.correctionId);
      await waitSeen(w, APPROVER);
      unset.release();
      expect(await asking).toBe('APPROVER_NOT_CONFIGURED');
    } finally {
      unset.release();
      await unset.done;
    }
    expect(await asksOn(w, asked.correctionId)).toEqual([]);
    expect(await w.stateOf(asked.correctionId)).toBe('live');
  });

  it('is stored when the unset waits behind it, and the unset lands after', async () => {
    const asked = await live(w);
    const chain = held(w, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        tx.businessId.toLowerCase(),
      ]);
    });
    await chain.ready;
    try {
      const asking = askOnOwn(asked.correctionId);
      await waitSeen(w, CHAIN);
      const unsetting = onOwn(w, unsetApprover);
      await waitSeen(w, SETTING_WRITE);
      chain.release();
      expect(await asking).toBe('not-a-refusal');
      await unsetting;
    } finally {
      chain.release();
      await chain.done;
    }
    expect((await asksOn(w, asked.correctionId)).length).toBe(1);
    expect(await configuredApprover()).toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)('a revert ask racing its correction leaving live', () => {
  it('stores nothing when it waits behind the correction being recorded reverted', async () => {
    const asked = await live(w);
    const leaving = held(w, async (tx) => {
      await tx.query(
        `update public.live_corrections set state = 'reverted', revision = revision + 1
          where business_id = $1 and id = $2`,
        [tx.businessId, asked.correctionId],
      );
    });
    await leaving.ready;
    try {
      const asking = askOnOwn(asked.correctionId);
      await waitOnCorrectionSeen();
      leaving.release();
      expect(await asking).toBe('TRANSITION_NOT_PERMITTED');
    } finally {
      leaving.release();
      await leaving.done;
    }
    expect(await asksOn(w, asked.correctionId)).toEqual([]);
    expect(await w.stateOf(asked.correctionId)).toBe('reverted');
  });
});
