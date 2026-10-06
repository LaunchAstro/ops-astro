// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for the person's own lease and the admin's own
// conversation, beside role-case-positive-body.ts to keep that file
// under the line limit. Moved whole from its switch: same bodies, same order.

import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { ownConversation } from './foreign-conversation.ts';
import {
  type Prepared,
  type BodyContext,
  ownLaunchedLease,
  ownLease,
  ownAppliedEffect,
} from './role-case-bodies.ts';

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
  | 'conversation.allowance'
  | 'conversation.rename'
  | 'conversation.set_scope'
  | 'conversation.models'
  | 'conversation.set_model'
>;

export async function leaseBody(name: LeaseCommand, context: BodyContext): Promise<Prepared> {
  switch (name) {
    case 'task.heartbeat':
      // The person renews their own lease (ledger line 38, "current lease
      // owner"). The agent's renewal is in the agent journey.
      return { body: await ownLease(context) };
    case 'task.dispatch':
      // The person marks their own launched lease's step dispatched (T2c1, AW-08).
      return { body: await ownLaunchedLease(context) };
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
    // AW-04: the drawer's allowance line, on the admin's own conversation.
    case 'conversation.allowance':
      return { body: { conversationId: await ownConversation(context) } };
    case 'conversation.rename':
      return { body: { conversationId: await ownConversation(context), title: 'Renamed' } };
    case 'conversation.set_scope':
      return {
        body: {
          conversationId: await ownConversation(context),
          page: { address: '/settings', shows: 'Settings' },
        },
      };
    // CS-7.30: the picker's offer and a choice back to the default.
    case 'conversation.models':
      return { body: { conversationId: await ownConversation(context) } };
    case 'conversation.set_model':
      return { body: { conversationId: await ownConversation(context), model: null } };
  }
}
