// SPDX-License-Identifier: AGPL-3.0-only
//
// One wording per refusal for both entries (thermo review b282216, O4).
//
// An agent and a person who send the same wrong operand, or name the same
// missing task, are told the same thing in the same bytes, and the text is the
// person entry's. The agent entry still refuses an operand before it reads the
// delegation (SOL-AUTHORITY-FIX, AUTHORITY-3); only the words are shared.
//
// Every refusal here is decided before a statement that needs a database, so
// the transaction is a stub. This suite moves the database counter by zero, so
// it is a unit suite and must not be named in `tests/db/named-suites.json`.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { AgentSession } from '../../packages/core-records/src/identity/agent-login.ts';
import type { CommandContext } from '../../packages/core-records/src/commands/context.ts';
import {
  AGENT_OPERATIONS,
  type AgentOperands,
  type AgentOperation,
  type AgentRequest,
} from '../../packages/core-records/src/commands/agent-operations.ts';
import { pickupAsPerson } from '../../packages/core-records/src/commands/tasks-pickup.ts';
import { heartbeatOwnLease } from '../../packages/core-records/src/commands/tasks-lease.ts';
import { handbackOwnLease } from '../../packages/core-records/src/commands/tasks-handback.ts';
import { refuseNotFound } from '../../packages/core-records/src/commands/refusal.ts';
import { refused } from '../../packages/core-records/src/commands/outcome.ts';

const BUSINESS = '11111111-1111-4111-8111-111111111111';
const TASK_TYPE = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

/** A transaction that knows the task spine and nothing else. */
const tx: TenantQuery = {
  businessId: BUSINESS,
  query: async <Row>(text: string, parameters: readonly unknown[] = []) => {
    if (text.includes('from record_types')) {
      const keys = parameters[1] as readonly string[];
      return keys.map((key, at) => ({ key, id: at === 0 ? TASK_TYPE : randomUUID() })) as Row[];
    }
    return await Promise.resolve([] as Row[]);
  },
};

const session: AgentSession = {
  businessId: BUSINESS,
  loginId: randomUUID(),
  actorId: ACTOR,
  kind: 'agent',
};

const person = {
  session: { personId: randomUUID(), actorId: ACTOR, roleKey: 'owner' },
  declaration: { collection: 'task' },
} as unknown as CommandContext;

function row(command: string): AgentOperation {
  const operation = AGENT_OPERATIONS.get(command as AgentRequest['command']);
  if (operation === undefined) throw new Error(`no agent row for ${command}`);
  return operation;
}

function agentOperands(command: string, fields: Record<string, unknown>): AgentOperands | object {
  const read = row(command).operands;
  if (read === undefined) throw new Error(`${command} reads no operands`);
  return read({ command, operationId: randomUUID(), ...fields } as AgentRequest);
}

async function agentServes(command: string, fields: Record<string, unknown>): Promise<unknown> {
  return await row(command).serve(
    tx,
    {
      session,
      credential: undefined,
      request: { command, operationId: randomUUID(), ...fields } as AgentRequest,
    },
    {},
    undefined,
  );
}

const WRONG_SECONDS: readonly unknown[] = [0, -5, 1.5, 'ninety', null, [60]];

describe('an operand refused on both entries', () => {
  it.each(WRONG_SECONDS)('task.pickup leaseSeconds %j', async (sent) => {
    const agent = agentOperands('task.pickup', { leaseSeconds: sent });
    const theirs = await pickupAsPerson(tx, person, {
      reservationId: randomUUID(),
      leaseSeconds: sent,
    } as never);
    expect(agent).toStrictEqual(theirs);
  });

  it.each(WRONG_SECONDS)('task.heartbeat leaseSeconds %j', async (sent) => {
    const agent = agentOperands('task.heartbeat', { leaseSeconds: sent });
    const theirs = await heartbeatOwnLease(tx, person, {
      leaseId: randomUUID(),
      fence: 1,
      leaseSeconds: sent,
    });
    expect(agent).toStrictEqual(theirs);
  });

  it.each([null, [1, 2], 'done', 7])('task.handback report %j', async (sent) => {
    const agent = agentOperands('task.handback', { report: sent });
    const theirs = await handbackOwnLease(tx, person, {
      leaseId: randomUUID(),
      fence: 1,
      outcome: 'completed',
      report: sent as never,
    });
    expect(agent).toStrictEqual(theirs);
  });
});

describe('a task that is not there, on both entries', () => {
  // The person entry answers both with the same two lines: `task.read`
  // through `reads/dispatch.ts` (`refuseNotFound`) and `task.comment` through
  // `prepare.ts`, whose text is the same.
  it.each(['task.read', 'task.comment'])('%s names a task nobody has', async (command) => {
    const agent = await agentServes(command, {
      recordId: randomUUID(),
      body: 'a note',
      audience: 'internal',
    });
    expect(agent).toStrictEqual(refused(refuseNotFound()));
  });

  it.each(['task.read', 'task.comment'])(
    '%s names something that is not an identifier',
    async (command) => {
      const agent = await agentServes(command, {
        recordId: 'not-a-task',
        body: 'a note',
        audience: 'internal',
      });
      expect(agent).toStrictEqual(refused(refuseNotFound()));
    },
  );
});
