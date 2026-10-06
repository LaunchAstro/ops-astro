// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent conversation's write operands (MP-7-11, CS-7.30), moved whole from
// `write-operands.ts` to keep it under its line cap; it spreads them back in.

import type { CommandName } from './command-names.ts';

/** The one operand kind these use, a narrowing of `write-operands.ts`'s `Operand`. */
type Spec = Readonly<Record<string, 'any'>>;

export const CONVERSATION_OPERANDS: Readonly<Partial<Record<CommandName, Spec>>> = {
  'conversation.start': {
    body: 'any',
    title: 'any',
    subject: 'any',
    scope: 'any',
    model: 'any',
  },
  'conversation.message': { conversationId: 'any', body: 'any' },
  'conversation.rename': { conversationId: 'any', title: 'any' },
  'conversation.set_scope': { conversationId: 'any', page: 'any' },
  'conversation.set_model': { conversationId: 'any', model: 'any' },
};
