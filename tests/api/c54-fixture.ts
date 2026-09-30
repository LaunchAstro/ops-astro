// SPDX-License-Identifier: AGPL-3.0-only
//
// C54's world against Postgres: the acceptance world (the real `createApi`
// over a fresh database, two businesses), the page's own OperationsClient
// bound to it, and the unknown effect the Agent pane answers for, made through
// the routes as T2d makes one (dispatched, applied, observed above the hold).
// Kept apart so each C54 suite stays under the per-file cap.

import { randomUUID } from 'node:crypto';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { insertActor, insertLogin, insertMapping, insertPerson } from '../identity/fixture.ts';
import { asBrowser } from '../support/sign-in.ts';
import {
  approvedReservationId,
  approvedTaskId,
  ownUnknownAttempt,
  type BodyContext,
} from '../acceptance/role-case-bodies.ts';
import {
  agentPath,
  bearer,
  call,
  personPath,
  tokenFor,
  type Answer,
  type World,
} from '../acceptance/world.ts';
import { asBrowser } from '../support/sign-in.ts';

/** Someone who can sign in to one business, with the token they present. */
export interface Signed extends Member {
  readonly token: string;
  readonly businessKey: string;
}

const pathOf = (name: CommandName): string => `/${name.replace('.', '/')}`;

/** A command or read on the person prefix, as `who`. */
export const asPerson = async (
  world: World,
  who: Signed,
  name: CommandName,
  body: Readonly<Record<string, unknown>>,
): Promise<Answer> =>
  await call(
    world.api,
    personPath(who.businessKey, pathOf(name)),
    { operationId: randomUUID(), ...body },
    bearer(who.token),
  );

/** A command on the agent prefix, under the delegation `credential` names. */
export const asAgent = async (
  world: World,
  name: CommandName,
  body: Readonly<Record<string, unknown>>,
  credential: string,
): Promise<Answer> =>
  await call(
    world.api,
    agentPath('alpha', pathOf(name)),
    { operationId: randomUUID(), ...body },
    { ...bearer(world.agent.token), 'x-agent-delegation': credential },
  );

/** The page's real client (apps/web), its fetch the real API's own; `seen` hears each status. */
export const pageClient = (
  world: World,
  who: Signed,
  seen: (status: number) => void = () => {},
): OperationsClient =>
  new OperationsClient({
    origin: 'http://api.test',
    businessKey: who.businessKey,
    signedIn: true,
    fetch: asBrowser(who.token, async (input, init) => {
      const response = await world.api.fetch(new Request(input, init));
      seen(response.status);
      return response;
    }),
  });

/** The world's cast member as a signed caller. */
export const signed = (member: World['ada']): Signed => ({
  personId: member.personId as string,
  actorId: member.actorId as string,
  presented: member.presented,
  token: member.token,
  businessKey: member.businessKey,
});

/** A new person of `business`, granted `billing:decide` on the whole business or on one task. */
export async function billingHolder(
  world: World,
  business: BusinessId,
  businessKey: string,
  name: string,
  taskId?: string,
): Promise<Signed> {
  const member = await enrol(world.db.app, business, name);
  await world.db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, member, 'read');
    const scope = taskId === undefined ? undefined : { kind: 'record' as const, id: taskId };
    await grantTo(tx, member, 'decide', scope, false, 'billing');
  });
  return { ...member, token: await tokenFor(member.presented.subject), businessKey };
}

/** An external client of alpha on the one task `sharer` shares, also granted `billing:decide` on it. */
export async function externalClient(
  world: World,
  sharer: Signed,
  taskId: string,
): Promise<Signed> {
  const subject = `c54-client-${randomUUID()}`;
  const member = await world.db.app.withBusiness(world.alpha, async (tx): Promise<Member> => {
    const personId = await insertPerson(tx, 'c54-client');
    const actorId = await insertActor(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, sharer.actorId);
    const shared = await shareRecord(
      tx,
      { personId: sharer.personId, actorId: sharer.actorId },
      { collection: 'task', recordId: taskId, personId },
    );
    if (!shared.ok) throw new Error(`share refused ${shared.refusal.code}`);
    return { personId, actorId, presented: { provider: 'supabase', subject } };
  });
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await grantTo(tx, member, 'decide', { kind: 'record', id: taskId }, false, 'billing');
  });
  return { ...member, token: await tokenFor(subject), businessKey: 'alpha' };
}

/** The role-case bodies' context, as `who`. */
export const contextOf = (world: World, who: Signed): BodyContext => ({
  alphaTaskId: '',
  assigneePersonId: who.personId,
  asPerson: async (name, body) => await asPerson(world, who, name, body),
  freshTask: async (title) => {
    const made = await asPerson(world, who, 'task.create', { fields: { title } });
    if (made.code !== 'ok') throw new Error(`c54: task.create refused ${made.code}`);
    return { id: String(made.body['recordId']), revision: Number(made.body['revision']) };
  },
});

/** A task with an attempt held unknown (T2d), on `who`'s own lease. */
export interface UnknownWork {
  readonly taskId: string;
  readonly attemptId: string;
}

export async function unknownWork(world: World, who: Signed): Promise<UnknownWork> {
  const made = await ownUnknownAttempt(contextOf(world, who));
  return { taskId: String(made['recordId']), attemptId: String(made['attemptId']) };
}

/** A task whose plan `who` approved: an envelope to top up. */
export const plannedTask = async (world: World, who: Signed): Promise<string> =>
  await approvedTaskId(contextOf(world, who));

/** Approved work the agent picked up: the delegation it works under, and its task. */
export async function agentOnWork(
  world: World,
  who: Signed,
): Promise<{ readonly taskId: string; readonly credential: string }> {
  const reservationId = await approvedReservationId(contextOf(world, who));
  const picked = await call(
    world.api,
    agentPath('alpha', '/task/pickup'),
    { operationId: randomUUID(), reservationId },
    bearer(world.agent.token),
  );
  if (picked.code !== 'ok') throw new Error(`c54: agent pickup refused ${picked.code}`);
  const detail = picked.body['detail'] as Record<string, unknown>;
  return { taskId: String(detail['taskId']), credential: String(detail['credential']) };
}

/** The attempt, its hold and its envelope, as the money commands leave them. */
export async function holdOf(
  world: World,
  attemptId: string,
): Promise<Record<string, unknown> | undefined> {
  return (
    await world.db.admin.execute<Record<string, unknown>>(
      `select att.state as attempt_state, att.outcome, res.state as reservation_state,
              res.actual_minor::text as reservation_actual, res.classified_cause,
              env.held_minor::text as envelope_held, env.actual_minor::text as envelope_actual,
              env.maximum_minor::text as envelope_maximum
         from public.attempts att
         join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
         join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
        where att.id = $1`,
      [attemptId],
    )
  )[0];
}

/** The open envelope's maximum on a task, as a number. */
export async function maximumOf(world: World, taskId: string): Promise<number> {
  const found = await world.db.admin.execute<{ readonly maximum: string }>(
    `select maximum_minor::text as maximum from public.task_envelopes
      where task_id = $1 and state = 'open'`,
    [taskId],
  );
  return Number(found[0]?.maximum);
}

/** The audit events a command wrote about a task, oldest first. */
export async function auditOf(
  world: World,
  taskId: string,
  command: string,
): Promise<readonly Record<string, unknown>[]> {
  return await world.db.admin.execute<Record<string, unknown>>(
    `select actor_id, command, operation_id, outcome, refusal_code, subject_record_id, hash
       from public.audit_events
      where subject_record_id = $1 and command = $2
      order by seq`,
    [taskId, command],
  );
}

/** The shipped four-eyes band of one business, in whole currency units. */
export async function setBand(world: World, business: BusinessId, value: string): Promise<void> {
  await world.db.admin.execute(
    `update public.business_settings set value = $2::text::jsonb
      where business_id = $1 and key = 'four_eyes_threshold'`,
    [business, value],
  );
}
