// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's comment locks its task with the person entry's own statement
// (thermo review b282216, O8; lead ruling: exactly what `lockTask` selects).
//
// Both transactions are stubs that record what they are sent, so the
// comparison is the statement text and its parameters and nothing else. This
// suite moves the database counter by zero, so it is a unit suite and must not
// be named in `tests/db/named-suites.json`.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { AgentSession } from '../../packages/core-records/src/identity/agent-login.ts';
import { AGENT_OPERATIONS } from '../../packages/core-records/src/commands/agent-operations.ts';
import type { AgentRequest } from '../../packages/core-records/src/commands/agent-call.ts';
import { lockTask } from '../../packages/core-records/src/commands/prepare.ts';
import { declarationOf } from '../../packages/core-records/src/commands/surface.ts';

const BUSINESS = '11111111-1111-4111-8111-111111111111';
const TASK_TYPE = '22222222-2222-4222-8222-222222222222';

interface Sent {
  readonly text: string;
  readonly parameters: readonly unknown[];
}

/** A transaction that knows the task spine, records every statement, and finds no task. */
function recording(): { readonly tx: TenantQuery; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  const tx: TenantQuery = {
    businessId: BUSINESS,
    query: async <Row>(text: string, parameters: readonly unknown[] = []) => {
      sent.push({ text, parameters });
      if (text.includes('from record_types')) {
        const keys = parameters[1] as readonly string[];
        return keys.map((key, at) => ({ key, id: at === 0 ? TASK_TYPE : randomUUID() })) as Row[];
      }
      return await Promise.resolve([] as Row[]);
    },
  };
  return { tx, sent };
}

const locks = (sent: readonly Sent[]): readonly Sent[] =>
  sent.filter((statement) => /\bfor update\b/u.test(statement.text));

describe('the task an agent comments on', () => {
  it('is locked by the statement lockTask sends, with the same parameters', async () => {
    const recordId = randomUUID();
    const person = recording();
    await lockTask(person.tx, TASK_TYPE, recordId);

    const agent = recording();
    const session: AgentSession = {
      businessId: BUSINESS,
      loginId: randomUUID(),
      actorId: randomUUID(),
      kind: 'agent',
    };
    const comment = AGENT_OPERATIONS.get('task.comment');
    const declaration = declarationOf('task.comment');
    if (comment?.authority !== 'record' || declaration === undefined) {
      throw new Error('no agent record row for task.comment');
    }
    await comment.serve(
      agent.tx,
      {
        session,
        credential: undefined,
        request: {
          command: 'task.comment',
          operationId: randomUUID(),
          recordId,
          body: 'a note',
          audience: 'internal',
        } as AgentRequest,
        declaration,
      },
      {},
      // The comment row does not read its delegation.
      undefined as never,
    );

    expect(locks(person.sent)).toHaveLength(1);
    expect(locks(agent.sent)).toStrictEqual(locks(person.sent));
  });
});
