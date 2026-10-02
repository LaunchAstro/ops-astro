// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for cancelling and restarting a lineage, moved
// whole from role-case-positive-body.ts to keep that file under the line limit:
// same bodies, same order.

import { lineageOn, type Prepared, type BodyContext } from './role-case-bodies.ts';

export async function lineageBody(
  name: 'task.cancel' | 'task.restart',
  context: BodyContext,
): Promise<Prepared> {
  switch (name) {
    case 'task.cancel': {
      // A lineage to cancel is a proposal's, so one is proposed first.
      const task = await context.freshTask('a task whose lineage is cancelled');
      const lineageId = await lineageOn(context, task);
      return { body: { recordId: task.id, lineageId, reason: 'the admin cancels it' } };
    }
    case 'task.restart': {
      // Only a rejected or cancelled lineage is restarted, so this one is
      // proposed and cancelled through the routes before the restart.
      const task = await context.freshTask('a task whose lineage is restarted');
      const lineageId = await lineageOn(context, task);
      const cancelled = await context.asPerson('task.cancel', {
        recordId: task.id,
        lineageId,
        reason: 'cancelled so it can be restarted',
      });
      if (cancelled.code !== 'ok') throw new Error(`matrix: cancel refused ${cancelled.code}`);
      return { body: { recordId: task.id, lineageId } };
    }
  }
}
