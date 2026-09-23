// SPDX-License-Identifier: AGPL-3.0-only
//
// One business with an agent login in it, for the agent envelope's own cases.
//
// Each case enrols its own deciding person, so revoking that person's grant
// narrows only the delegation that case minted. The agent is shared: it may
// hold one live delegation per purpose, and every case picks up its own task.

import { randomUUID } from 'node:crypto';
import {
  createFreshDatabase,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import type { Action } from '../../packages/core-records/src/authority/grants.ts';

export const codeOf = (result: CommandResult): string =>
  isCommandRefusal(result) ? result.code : 'not-a-refusal';
export const detailOf = (result: CommandResult): Record<string, unknown> =>
  isCommandRefusal(result) ? {} : (result.detail as Record<string, unknown>);

type Body = Readonly<Record<string, unknown>>;

export interface Decider extends Member {
  readonly grants: Readonly<Record<Action, string>>;
}

export interface PickedUp {
  readonly taskId: string;
  readonly credential: string;
  readonly detail: Record<string, unknown>;
  readonly operationId: string;
  readonly reservationId: string;
}

export interface AgentWorld {
  readonly db: FreshDatabase;
  readonly business: BusinessId;
  readonly agentActorId: string;
  asPerson(member: Member, body: Body): Promise<CommandResult>;
  asAgent(body: Body, credential?: string): Promise<CommandResult>;
  /** A person holding read, write, decide and comment on tasks, each a grant of its own. */
  decider(name: string): Promise<Decider>;
  /** A task approved by `by`, picked up by the agent. */
  pickUp(by: Decider, title: string): Promise<PickedUp>;
  /** The person path's `grant.revoke` and `delegation.revoke`, run by a manager. */
  revokeGrant(grantId: string): Promise<void>;
  revokeDelegation(delegationId: string): Promise<void>;
  commentsOn(taskId: string): Promise<number>;
  auditFor(operationId: string): Promise<readonly { outcome: string; code: string | null }[]>;
  drop(): Promise<void>;
}

/** A setup step's detail, with the record it named, or the refusal thrown. */
function ok(result: CommandResult, what: string): Record<string, unknown> {
  if (isCommandRefusal(result)) throw new Error(`${what} refused ${result.code}`);
  return { ...(result.detail as Record<string, unknown>), recordId: result.recordId };
}

const TASK_ACTIONS: readonly Action[] = ['read', 'write', 'decide', 'comment'];

export async function agentWorld(part: string, key: string): Promise<AgentWorld> {
  process.env['GATE_SIGNING_KEY_ID'] = `test/${key}@1`;
  process.env['GATE_SIGNING_SECRET'] = randomUUID();
  const db = await createFreshDatabase({ part });
  const business = (await insertBusiness(db.app, key)) as BusinessId;
  await installSpine(db.app, business);
  const manager = await enrol(db.app, business, 'manager');
  const agentActorId = randomUUID();
  let agent: VerifiedSubject = { provider: 'supabase', subject: '' };
  await db.app.withBusiness(business, async (tx) => {
    // A manager revokes only a pair it holds itself (`controls-revoke.test.ts`).
    for (const action of [...TASK_ACTIONS, 'manage'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, manager, action);
    }
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'local', 5000000, 'AUD')`,
      [business, randomUUID()],
    );
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      business,
      agentActorId,
    ]);
    const subject = `agent-${randomUUID()}`;
    const loginId = await insertLogin(tx, subject);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [business, randomUUID(), loginId, agentActorId, manager.actorId],
    );
    agent = { provider: 'supabase', subject };
  });

  const asPerson = async (member: Member, body: Body): Promise<CommandResult> =>
    await executeCommand(db.app, business, member.presented, 'api', body as never);

  const asAgent = async (body: Body, credential?: string): Promise<CommandResult> =>
    (await executeAgentCommand(
      db.app,
      business,
      agent,
      credential,
      body as never,
    )) as CommandResult;

  const revisionOf = async (recordId: string): Promise<number> => {
    const rows = await db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where business_id = $1 and id = $2`,
      [business, recordId],
    );
    return Number(rows[0]?.revision ?? '0');
  };

  return {
    db,
    business,
    agentActorId,
    asPerson,
    asAgent,
    async decider(name) {
      const member = await enrol(db.app, business, name);
      const grants = await db.app.withBusiness(business, async (tx) => {
        const issued: Partial<Record<Action, string>> = {};
        for (const action of TASK_ACTIONS) {
          // eslint-disable-next-line no-await-in-loop
          issued[action] = await grantTo(tx, member, action);
        }
        return issued as Record<Action, string>;
      });
      return { ...member, grants };
    },
    async pickUp(by, title) {
      const created = ok(
        await asPerson(by, {
          command: 'task.create',
          operationId: randomUUID(),
          fields: { title },
        }),
        'task.create',
      );
      const taskId = String(created['recordId']);
      const proposed = ok(
        await asPerson(by, {
          command: 'task.propose',
          operationId: randomUUID(),
          recordId: taskId,
          expectedRevision: await revisionOf(taskId),
          // One live delegation per agent and purpose word, so each case works under its own.
          purpose: `draft_${randomUUID().slice(0, 8)}`,
          maximumMinor: 3_000,
          currency: 'AUD',
          payload: { instruction: 'draft a reply' },
          step: { kind: 'compose', payload: {} },
        }),
        'task.propose',
      );
      const decided = ok(
        await asPerson(by, {
          command: 'task.decide',
          operationId: randomUUID(),
          gateId: proposed['gateId'],
          versionId: proposed['versionId'],
          decision: 'approve',
          note: 'approved so an agent can work it',
        }),
        'task.decide',
      );
      const reservationId = String(decided['reservationId']);
      const operationId = randomUUID();
      const detail = ok(
        await asAgent({ command: 'task.pickup', operationId, reservationId }),
        'task.pickup',
      );
      return {
        taskId,
        credential: String(detail['credential']),
        detail,
        operationId,
        reservationId,
      };
    },
    async revokeGrant(grantId) {
      ok(
        await asPerson(manager, { command: 'grant.revoke', operationId: randomUUID(), grantId }),
        'grant.revoke',
      );
    },
    async revokeDelegation(delegationId) {
      ok(
        await asPerson(manager, {
          command: 'delegation.revoke',
          operationId: randomUUID(),
          delegationId,
        }),
        'delegation.revoke',
      );
    },
    async commentsOn(taskId) {
      const rows = await db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.records
          where business_id = $1 and data->>'task' = $2`,
        [business, taskId],
      );
      return Number(rows[0]?.n ?? '0');
    },
    async auditFor(operationId) {
      return await db.app.withBusiness(business, async (tx) =>
        (await readAuditEvents(tx))
          .filter((event) => event.operation_id === operationId)
          .map((event) => ({ outcome: event.outcome, code: event.refusal_code })),
      );
    },
    async drop() {
      await db.drop();
    },
  };
}
