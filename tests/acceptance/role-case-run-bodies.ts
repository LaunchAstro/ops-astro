// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for the budget, the person's own lease and the
// admin's own conversation, beside role-case-positive-body.ts to keep that file
// under the line limit. Moved whole from its switch: same bodies, same order.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { ownConversation } from './foreign-conversation.ts';
import {
  PROPOSAL,
  type Prepared,
  type BodyContext,
  approvedTaskId,
  ownLease,
  ownAppliedEffect,
  ownUnknownAttempt,
} from './role-case-bodies.ts';

type BudgetCommand = Extract<
  CommandName,
  'budget.top_up' | 'budget.record_outcome' | 'budget.write_off'
>;

type LeaseCommand = Extract<
  CommandName,
  'task.heartbeat' | 'task.dispatch' | 'task.check' | 'task.observe' | 'task.receipt'
>;

type ConversationCommand = Extract<
  CommandName,
  | 'conversation.start'
  | 'conversation.message'
  | 'conversation.read'
  | 'conversation.list'
  | 'conversation.rename'
  | 'conversation.set_scope'
>;

export async function budgetBody(name: BudgetCommand, context: BodyContext): Promise<Prepared> {
  switch (name) {
    case 'budget.top_up':
      // The admin approved the plan and holds billing, so a top-up under
      // the band is hers alone (T2e).
      return {
        body: {
          recordId: await approvedTaskId(context),
          amountMinor: 100,
          fromMaximumMinor: PROPOSAL.maximumMinor,
        },
      };
    case 'budget.record_outcome':
      // The admin holds billing, so any unknown attempt on the business's
      // tasks is hers to record (O8, T3d1).
      return { body: { ...(await ownUnknownAttempt(context)), outcome: 'happened' } };
    case 'budget.write_off':
      // The same unknown hold, closed at nothing with a reason (T3c).
      return {
        body: {
          ...(await ownUnknownAttempt(context)),
          amountMinor: 0,
          reason: 'The matrix writes its own unknown hold off.',
        },
      };
  }
}

export async function leaseBody(name: LeaseCommand, context: BodyContext): Promise<Prepared> {
  switch (name) {
    case 'task.heartbeat':
      // The person renews their own lease (ledger line 38, "current lease
      // owner"). The agent's renewal is in the agent journey.
      return { body: await ownLease(context) };
    case 'task.dispatch':
      // The person marks their own lease's step dispatched (T2c1).
      return { body: await ownLease(context) };
    case 'task.check':
      // A check recorded under the person's own lease (MP-6-1). The agent's
      // check under its delegation is in the agent journey.
      return {
        body: { ...(await ownLease(context)), name: 'the admin checks', outcome: 'passed' },
      };
    case 'task.observe':
      // The person observes the effect they applied on their own lease (T2c2).
      return { body: await ownAppliedEffect(context) };
    case 'task.receipt': {
      // The receipt of an effect the person applied and observed (T2c2).
      const applied = await ownAppliedEffect(context);
      const observed = await context.asPerson('task.observe', applied);
      if (observed.code !== 'ok') throw new Error(`matrix: observe refused ${observed.code}`);
      return { body: { attemptId: applied.attemptId } };
    }
  }
}

export async function conversationBody(
  name: ConversationCommand,
  context: BodyContext,
): Promise<Prepared> {
  switch (name) {
    // AW-03. The admin holds `conversation:write`, so starts one of their own;
    // the message and the read name a conversation the admin just started.
    case 'conversation.start':
      return { body: { body: 'the admin asks the agent', subject: 'acceptance' } };
    case 'conversation.message':
      return { body: { conversationId: await ownConversation(context), body: 'and again' } };
    case 'conversation.read':
      return { body: { conversationId: await ownConversation(context) } };
    // MP-7-11. The tab row: the admin's own list, and a title and a page
    // on the conversation the admin just started.
    case 'conversation.list':
      return { body: {} };
    case 'conversation.rename':
      return { body: { conversationId: await ownConversation(context), title: 'Renamed' } };
    case 'conversation.set_scope':
      return {
        body: {
          conversationId: await ownConversation(context),
          page: { address: '/settings', shows: 'Settings' },
        },
      };
  }
}
