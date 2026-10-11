// SPDX-License-Identifier: AGPL-3.0-only
//
// Make my agent (Assign to AI): `agent.create` makes an agent the caller owns,
// `agent.rename` renames one of the caller's own, and `agent.mine` lists the
// caller's own. Then the agent is handed a task and every person reader sees
// it by name. Crossings, statuses checked: another person's agent, another
// business's agent, and a person who is not a member of the business. Making
// or naming an agent starts nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { codeOf, detailOf } from './agent-fixture.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import {
  aiWorld,
  assign,
  created,
  heldAs,
  holder,
  offered,
  type AiWorld,
} from './ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('agent-make: DATABASE_URL is unset, so nothing ran.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('agentmake');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

const send = async (
  by: Member,
  body: Readonly<Record<string, unknown>>,
  business: string = w.world.business,
): Promise<CommandResult> =>
  await executeCommand(w.world.db.app, business, by.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);

const make = async (by: Member, name: string): Promise<string> => {
  const answer = await send(by, { command: 'agent.create', name });
  expect(codeOf(answer)).toBe('not-a-refusal');
  return String(detailOf(answer)['agentId']);
};

const mine = async (by: Member, business: string = w.world.business): Promise<unknown> => {
  const read = await executeRead(w.world.db.app, business, by.presented, { read: 'agent.mine' });
  if (isCommandRefusal(read)) return read.code;
  return (read as unknown as { readonly agents: unknown }).agents;
};

const nameOf = async (agentId: string): Promise<string | null | undefined> =>
  (
    await w.world.db.admin.execute<{ readonly name: string | null }>(
      `select display_name as name from public.actors where id = $1`,
      [agentId],
    )
  )[0]?.name;

describe.skipIf(serverUrl === undefined)('Make my agent', () => {
  it('a member makes an agent they own, lists it, and hands it a task everyone sees by name', async () => {
    const agentId = await make(w.p, '  Penny  ');
    expect(await mine(w.p)).toContainEqual({ agentId, name: 'Penny' });
    const task = await created(w, w.q, 'For Penny');
    expect(await offered(w, w.p, task)).toContainEqual({ agentId, name: 'Penny' });
    expect(codeOf(await assign(w, w.p, task, { agent: agentId }))).toBe('not-a-refusal');
    expect(await holder(w, task)).toStrictEqual({ agent: agentId, person: null });
    expect(await heldAs(w, w.q, task)).toMatchObject({
      agentId,
      name: 'Penny',
      owner: { personId: w.p.personId },
      live: false,
    });
  });

  it('the owner renames it, and the task shows the new name', async () => {
    const agentId = await make(w.p, 'Drafty');
    const task = await created(w, w.p, 'Renamed agent');
    await assign(w, w.p, task, { agent: agentId });
    const renamed = await send(w.p, { command: 'agent.rename', agentId, name: 'Reply drafter' });
    expect(codeOf(renamed)).toBe('not-a-refusal');
    expect(await heldAs(w, w.q, task)).toMatchObject({ agentId, name: 'Reply drafter' });
  });

  it('a name that is empty, too long or carries a control character is refused, and nothing changes', async () => {
    const agentId = await make(w.p, 'Kept');
    for (const name of ['', '   ', 'x'.repeat(61), 'bad\u0007name', 42]) {
      /* eslint-disable no-await-in-loop -- one refusal each */
      expect(codeOf(await send(w.p, { command: 'agent.create', name }))).toBe(
        'FIELD_VALUE_INVALID',
      );
      expect(codeOf(await send(w.p, { command: 'agent.rename', agentId, name }))).toBe(
        'FIELD_VALUE_INVALID',
      );
      /* eslint-enable no-await-in-loop */
    }
    expect(await nameOf(agentId)).toBe('Kept');
  });
});

describe.skipIf(serverUrl === undefined)('Make my agent: what making writes', () => {
  it('making an agent starts nothing: no delegation, lease or reservation', async () => {
    const count = async (): Promise<string | undefined> =>
      (
        await w.world.db.admin.execute<{ readonly n: string }>(
          `select (select count(*) from public.delegations) + (select count(*) from public.leases)
                + (select count(*) from public.reservations) as n`,
        )
      )[0]?.n;
    const before = await count();
    await make(w.p, 'Idle');
    expect(await count()).toBe(before);
  });
});

describe.skipIf(serverUrl === undefined)('Make my agent: crossings', () => {
  it('person to person: Q cannot rename P’s agent, and does not list it', async () => {
    const agentId = await make(w.p, 'P only');
    const answer = await send(w.q, { command: 'agent.rename', agentId, name: 'Taken over' });
    expect(codeOf(answer)).toBe('NOT_FOUND');
    expect(JSON.stringify(answer)).not.toContain('P only');
    expect(await nameOf(agentId)).toBe('P only');
    expect(JSON.stringify(await mine(w.q))).not.toContain(agentId);
  });

  it('business to business: a person of B cannot rename or list A’s agent', async () => {
    const agentId = await make(w.p, 'Home agent');
    const bravo = await insertBusiness(w.world.db.app, `agent-b-${randomUUID().slice(0, 8)}`);
    await installSpine(w.world.db.app, bravo);
    const there = await enrol(w.world.db.app, bravo, 'there');
    await w.world.db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, there, 'assign', undefined, false, 'agent');
    });
    const answer = await send(there, { command: 'agent.rename', agentId, name: 'Away' }, bravo);
    expect(codeOf(answer)).toBe('NOT_FOUND');
    expect(await nameOf(agentId)).toBe('Home agent');
    expect(await mine(there, bravo)).toEqual([]);
  });

  it('a person who is not a member of the business makes and renames no agent', async () => {
    const agentId = await make(w.p, 'Members only');
    const guest = await enrol(w.world.db.app, w.world.business, `guest-${randomUUID()}`);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await tx.query(`update public.memberships set role_key = 'client' where person_id = $1`, [
        guest.personId,
      ]);
      await grantTo(tx, guest, 'read');
    });
    const made = await send(guest, { command: 'agent.create', name: 'Client agent' });
    expect(codeOf(made)).toBe('SCOPE_NOT_GRANTED');
    const renamed = await send(guest, { command: 'agent.rename', agentId, name: 'Client agent' });
    expect(codeOf(renamed)).toBe('SCOPE_NOT_GRANTED');
    expect(await mine(guest)).toEqual([]);
  });
});
