// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent credential is judged live once its row is locked `for share`
// (`resolveAgentCredential`). The instant it is judged at must be read after
// that lock wait, not taken from the request before it: a credential that
// expires while its call waits on its row is not live when the call goes on.
//
// Each case issues a real credential four seconds from expiry, holds its row
// `for update` on another connection, sees the agent call wait on that holder
// with its transaction begun before the expiry, lets the database clock pass
// the expiry, and only then lets go. The call is refused `DELEGATION_NOT_LIVE`
// and acts on nothing.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bearer, serverUrl, type Answer } from '../acceptance/world.ts';
import { blockedBefore, holdRow, instantOf, waitPast } from '../support/lock-wait-race.ts';
import { harness, openWorld } from './api-2-agent-credential-world.ts';
import {
  agentComments,
  asCredential,
  comment,
  issued,
  type Issued,
} from './api-2-agent-credential-use-world.ts';

openWorld();

const TASK_WRITE = [
  { collection: 'task', action: 'read' },
  { collection: 'task', action: 'write' },
];

/** Applied events of `command` whose actor is this credential's agent. */
async function agentActs(credentialId: string, command: string): Promise<number> {
  const rows = await harness.world.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.audit_events e
       join public.agent_credentials c
         on c.business_id = e.business_id and c.agent_actor_id = e.actor_id
      where c.id = $1 and e.command = $2 and e.outcome = 'applied'`,
    [credentialId, command],
  );
  return Number(rows[0]?.n ?? '-1');
}

/**
 * `send` made with a credential that expires while the call waits on the
 * credential's row: the answer, and whether the call's transaction began
 * before the expiry.
 */
async function acrossExpiry(
  credential: Issued,
  send: () => Promise<Answer>,
): Promise<{ readonly answer: Answer; readonly startedLive: boolean }> {
  const { db } = harness.world;
  const expiry = await instantOf(
    db,
    'select expires_at::text as at from public.agent_credentials where id = $1',
    [credential.id],
  );
  const held = await holdRow(
    db,
    'select id from public.agent_credentials where id = $1 for update',
    [credential.id],
  );
  const sent = send();
  let startedLive = false;
  try {
    startedLive = await blockedBefore(db, held, expiry);
    await waitPast(db, expiry);
  } finally {
    await held.letGo();
  }
  return { answer: await sent, startedLive };
}

const soon = (): string => new Date(Date.now() + 4_000).toISOString();

describe.skipIf(serverUrl === undefined)('a credential expiring in its row-lock wait', () => {
  it('an agent credential that expires during its row-lock wait cannot create a task', async () => {
    const credential = await issued({ scope: TASK_WRITE, expiresAt: soon() });
    const { answer, startedLive } = await acrossExpiry(
      credential,
      async () =>
        await asCredential(
          'task.create',
          { fields: { title: `made across expiry ${randomUUID()}` } },
          bearer(credential.secret),
        ),
    );
    expect({
      startedLive,
      code: answer.code,
      created: await agentActs(credential.id, 'task.create'),
    }).toEqual({ startedLive: true, code: 'DELEGATION_NOT_LIVE', created: 0 });
  }, 30_000);

  it('an agent credential that expires during its row-lock wait cannot comment on a task', async () => {
    const credential = await issued({ expiresAt: soon() });
    const { answer, startedLive } = await acrossExpiry(
      credential,
      async () => await comment(bearer(credential.secret)),
    );
    expect({
      startedLive,
      status: answer.status,
      code: answer.code,
      comments: await agentComments(credential.id),
    }).toEqual({ startedLive: true, status: 401, code: 'DELEGATION_NOT_LIVE', comments: 0 });
  }, 30_000);

  it('an agent credential that expires during its row-lock wait cannot read a task', async () => {
    const credential = await issued({ expiresAt: soon() });
    const { answer, startedLive } = await acrossExpiry(
      credential,
      async () =>
        await asCredential(
          'task.read',
          { recordId: harness.alphaTask.id },
          bearer(credential.secret),
        ),
    );
    expect({ startedLive, status: answer.status, code: answer.code }).toEqual({
      startedLive: true,
      status: 401,
      code: 'DELEGATION_NOT_LIVE',
    });
  }, 30_000);
});
