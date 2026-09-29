// SPDX-License-Identifier: AGPL-3.0-only
//
// A wayfinder world: the agent world (one business with a manager, an agent
// login and a budget cap) plus a second business, and helpers that drive the
// wayfinder commands and reads through the real envelopes.
//
// Every call goes through `executeCommand`, `executeAgentCommand` or
// `executeRead`, the functions the HTTP routes call, so a test here exercises
// the route's own path rather than a handler called on its own.

import { randomUUID } from 'node:crypto';
import { agentWorld, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-commands/src/commands/audit.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { Action, Scope } from '../../packages/core-records/src/authority/grants.ts';

/* eslint-disable no-await-in-loop -- grants are issued one after another on one connection */

type Body = Readonly<Record<string, unknown>>;

export interface Made {
  readonly id: string;
  readonly revision: number;
}

export interface WayfinderWorld extends AgentWorld {
  readonly bravo: BusinessId;
  /** A person of the main business holding exactly the actions named, at the scope given. */
  member(name: string, actions: readonly Action[], scope?: Scope): Promise<Member>;
  /** A person of the second business holding read and write business-wide. */
  outsider(name: string): Promise<Member>;
  as(member: Member, body: Body, business?: BusinessId): Promise<CommandResult>;
  read(member: Member, body: Body, business?: BusinessId): Promise<unknown>;
  /** Create, or throw naming the refusal. */
  create(member: Member, fields: Body, extra?: Body, business?: BusinessId): Promise<Made>;
  revisionOf(recordId: string, business?: BusinessId): Promise<number>;
  audit(business?: BusinessId): Promise<readonly AuditLine[]>;
}

export interface AuditLine {
  readonly command: string;
  readonly outcome: string;
  readonly code: string | null;
  readonly subject: string | null;
  readonly operationId: string | null;
}

export const codeOf = (result: unknown): string =>
  isCommandRefusal(result as CommandResult) ? (result as { code: string }).code : 'applied';

export function must(result: CommandResult, what: string): Made {
  if (isCommandRefusal(result)) {
    throw new Error(`${what} refused ${result.code} ${JSON.stringify(result.names)}`);
  }
  return { id: result.recordId ?? '', revision: result.revision ?? 0 };
}

export async function wayfinderWorld(part: string, key: string): Promise<WayfinderWorld> {
  const world = await agentWorld(part, key);
  const bravo = (await insertBusiness(world.db.app, `${key}-bravo`)) as BusinessId;
  await installSpine(world.db.app, bravo);

  const as = async (member: Member, body: Body, business: BusinessId = world.business) =>
    await executeCommand(world.db.app, business, member.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as never);

  const revisionOf = async (recordId: string, business: BusinessId = world.business) => {
    const rows = await world.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where business_id = $1 and id = $2`,
      [business, recordId],
    );
    return Number(rows[0]?.revision ?? '0');
  };

  return {
    ...world,
    bravo,
    async member(name, actions, scope) {
      const member = await enrol(world.db.app, world.business, name);
      await world.db.app.withBusiness(world.business, async (tx) => {
        for (const action of actions) {
          await grantTo(tx, member, action, scope);
        }
      });
      return member;
    },
    async outsider(name) {
      const member = await enrol(world.db.app, bravo, name);
      await world.db.app.withBusiness(bravo, async (tx) => {
        await grantTo(tx, member, 'read');
        await grantTo(tx, member, 'write');
      });
      return member;
    },
    as,
    async read(member, body, business = world.business) {
      return await executeRead(world.db.app, business, member.presented, body as never);
    },
    async create(member, fields, extra = {}, business = world.business) {
      return must(
        await as(member, { command: 'task.create', fields, ...extra }, business),
        'create',
      );
    },
    revisionOf,
    async audit(business = world.business) {
      return await world.db.app.withBusiness(business, async (tx) =>
        (await readAuditEvents(tx)).map((event) => ({
          command: event.command,
          outcome: event.outcome,
          code: event.refusal_code,
          subject: event.subject_record_id,
          operationId: event.operation_id,
        })),
      );
    },
  };
}

export type { Decider, Member };
