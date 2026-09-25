// SPDX-License-Identifier: AGPL-3.0-only
//
// The handback and pickup operand refusals have one source, the person
// handlers' modules, and the agent entry answers in the same bytes
// (THERMO-RECHECK-2 NNA4). The texts are pinned here, so a change to one
// is a change to both entries and to this file.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  refuseActualMinor,
  refuseFence,
  refuseOutcome,
  refuseReport,
} from '../../packages/core-records/src/commands/tasks-handback.ts';
import { refuseReservationBody } from '../../packages/core-records/src/commands/tasks-pickup.ts';
import {
  AGENT_OPERATIONS,
  isOperandRefusal,
} from '../../packages/core-records/src/commands/agent-operations.ts';
import type { AgentRequest } from '../../packages/core-records/src/commands/agent-call.ts';
import type { CommandName } from '../../packages/core-records/src/commands/surface.ts';

const parse = (command: CommandName, fields: Record<string, unknown>): unknown => {
  const operation = AGENT_OPERATIONS.get(command);
  if (operation === undefined) throw new Error(`no agent row for ${command}`);
  const request = { command, operationId: randomUUID(), ...fields } as AgentRequest;
  return operation.open((row) => {
    const parsed = row.operands(request);
    return isOperandRefusal(parsed) ? parsed : { parsed };
  });
};

describe('operand refusal texts, one source for both entries', () => {
  it('pins the bytes', () => {
    expect(refuseOutcome('x')).toStrictEqual({
      refusal: {
        refused: true,
        code: 'FIELD_VALUE_INVALID',
        names: ['outcome'],
        fixes: ['An outcome is completed or failed.'],
      },
      attempted: { outcome: 'x' },
    });
    expect(refuseFence('1').refusal.fixes).toStrictEqual(['Send the fence the pickup handed you.']);
    expect(refuseReport([]).refusal.fixes).toStrictEqual([
      'Send report as an object of named values, or leave it out.',
    ]);
    expect(refuseActualMinor(5).refusal).toMatchObject({
      code: 'ACTUAL_EXPENDITURE_UNSUPPORTED',
      names: ['actualMinor'],
      fixes: [
        'Leave actualMinor out, or send null: nothing in this head dispatches.',
        'A number here would claim the work ran and cost that much.',
      ],
    });
    expect(refuseReservationBody()).toStrictEqual({
      refusal: {
        refused: true,
        code: 'COMMAND_BODY_INVALID',
        names: ['reservationId'],
        fixes: ['Name a reservation from task.queue.'],
      },
    });
  });

  it('answers the agent operands in those bytes', () => {
    const handback = { outcome: 'completed', fence: 1 };
    expect(parse('task.handback', { ...handback, outcome: ['completed'] })).toStrictEqual(
      refuseOutcome(['completed']),
    );
    expect(parse('task.handback', { ...handback, fence: '1' })).toStrictEqual(refuseFence('1'));
    expect(parse('task.handback', { ...handback, report: [1] })).toStrictEqual(refuseReport([1]));
    expect(parse('task.handback', { ...handback, actualMinor: 5 })).toStrictEqual(
      refuseActualMinor(5),
    );
    expect(parse('task.pickup', { reservationId: 42 })).toStrictEqual(refuseReservationBody());
  });
});
