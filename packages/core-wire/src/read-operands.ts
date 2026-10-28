// SPDX-License-Identifier: AGPL-3.0-only
//
// Each read's operands, in the kinds `write-operands.ts` uses, for the API
// scan's document (`scripts/security/api-definition.ts`). The read's own parse
// on its catalogue row (`core-commands/src/reads/catalogue.ts`) is what checks
// a body; this table only says what the body carries, and
// `the-api-scan-definition-declares-every-reads-operands.test.ts` holds the two
// in step: a required operand here is one the parse refuses without, and a body
// of every operand here at a valid value is one it takes.

import type { CommandName } from './command-names.ts';
import type { Operand } from './write-operands.ts';

/** The JSON an operand holds when no operand kind says it: an object's fields, a list's items. */
export interface OperandShape {
  readonly type: 'array' | 'object' | 'string';
  readonly properties?: Readonly<Record<string, OperandShape>>;
  readonly required?: readonly string[];
  readonly items?: OperandShape;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly enum?: readonly string[];
}

/** An operand by kind, or by shape (required unless `optional`). */
export type ReadOperand = Operand | { readonly shape: OperandShape; readonly optional?: true };

export type ReadOperands = Readonly<Record<string, ReadOperand>>;

/** One body, or one of several forms the read takes in its place (`task.board`). */
export type ReadBody = ReadOperands | { readonly oneOf: readonly ReadOperands[] };

const NONE = {} as const;
const RECORD = { recordId: 'id' } as const;
// The detail level, page size and page token of a task read (`reads/detail.ts`).
const PAGING = { detail: 'text?', limit: 'count?', page: 'text?' } as const;
const TODO_SCOPE = { person: 'id?', client: 'id?' } as const;
// A notice's recipient (`reads/operations.ts`): a name and an address, both required.
const RECIPIENT: OperandShape = {
  type: 'object',
  properties: { name: { type: 'string' }, address: { type: 'string' } },
  required: ['name', 'address'],
};

export const READ_OPERANDS: Readonly<Partial<Record<CommandName, ReadBody>>> = {
  'map.view': RECORD,
  'map.frontier': RECORD,
  'map.list': NONE,
  // The read refuses a missing one itself, after the door (`reads/conversation.ts`).
  'conversation.read': { conversationId: 'id' },
  'conversation.list': NONE,
  'conversation.allowance': { conversationId: 'id?|null' },
  'conversation.models': { conversationId: 'id?|null' },
  'task.read': { ...RECORD, ...PAGING, historyEventId: 'id?' },
  // `mode: 'aggregate'` stands in place of `board`, never beside it: two forms.
  'task.board': {
    oneOf: [
      { board: 'id|null', ...TODO_SCOPE, ...PAGING },
      { mode: { shape: { type: 'string', enum: ['aggregate'] } }, ...TODO_SCOPE, ...PAGING },
    ],
  },
  'task.search': { query: 'text' },
  'task.ledger': { timeZone: 'text', before: 'text?|null', query: 'text?|null' },
  'person.list': NONE,
  'tag.list': NONE,
  'task.todos': TODO_SCOPE,
  'team.list': NONE,
  'task.queue': NONE,
  'task.execution': { ...RECORD, cursor: 'count?' },
  'definition.attribution': { digest: 'text' },
  'gate.pending': NONE,
  'preset.plan': {
    recordTypeKey: 'text',
    presetKey: 'text',
    fields: { shape: { type: 'array', items: { type: 'object' } } },
  },
  'secret.list': NONE,
  'connection.fleet': NONE,
  'connection.signal': NONE,
  'connection.graduation': NONE,
  'finance.skill_costs': NONE,
  'finance.agent_costs': { from: 'text', to: 'text' },
  'settings.read': NONE,
  'session.capabilities': NONE,
  'task.receipt': { attemptId: 'id' },
  'session.person': NONE,
  'preference.read': NONE,
  'agent.mine': NONE,
  'access.read': NONE,
  'invitation.list': NONE,
  'client.list': NONE,
  'operations.read': NONE,
  'privacy.draft_breach_notices': {
    incidentId: 'id',
    oaic: { shape: RECIPIENT },
    people: { shape: { type: 'array', minItems: 1, maxItems: 500, items: RECIPIENT } },
    containment: 'text',
    steps: 'text',
  },
  'inbox.read': NONE,
  'inbox.count': NONE,
  'inbox.unattended': NONE,
  'chat.conversations': NONE,
  'chat.messages': { conversationId: 'id' },
  'trace.read': RECORD,
  'live_correction.read': { correctionId: 'id' },
  'live_correction.list': NONE,
  'live_correction.receipts': { correctionId: 'id' },
  'review.read': { reviewId: 'id' },
  'review.list': NONE,
  'review.picture': { pictureId: 'id' },
  'review.client_list': NONE,
  'automation.registry': NONE,
  'automation.history': { activationId: 'id', cursor: 'text?' },
};
