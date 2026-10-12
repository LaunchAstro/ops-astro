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
import type { OperandSpec } from './write-operands.ts';

const NONE = {} as const;
const RECORD = { recordId: 'id' } as const;
// The detail level, page size and page token of a task read (`reads/detail.ts`).
const PAGING = { detail: 'text?', limit: 'count?', page: 'text?' } as const;
const TODO_SCOPE = { person: 'id?', client: 'id?' } as const;

export const READ_OPERANDS: Readonly<Partial<Record<CommandName, OperandSpec>>> = {
  'map.view': RECORD,
  'map.frontier': RECORD,
  // The read refuses a missing one itself, after the door (`reads/conversation.ts`).
  'conversation.read': { conversationId: 'id' },
  'conversation.list': NONE,
  'conversation.allowance': { conversationId: 'id?|null' },
  'conversation.models': { conversationId: 'id?|null' },
  'task.read': { ...RECORD, ...PAGING, historyEventId: 'id?' },
  // `mode: 'aggregate'` stands in place of `board`, never beside it, and one
  // body schema cannot say either-or, so the board's body is the one declared.
  'task.board': { board: 'id|null', ...TODO_SCOPE, ...PAGING },
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
  // An array of field objects, which `map` (an object, not an array) is not.
  'preset.plan': { recordTypeKey: 'text', presetKey: 'text', fields: 'any' },
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
  'client.list': NONE,
  'operations.read': NONE,
  // `people` is a list of the same `{ name, address }` recipient `oaic` is.
  'privacy.draft_breach_notices': {
    incidentId: 'id',
    oaic: 'map',
    people: 'any',
    containment: 'text',
    steps: 'text',
  },
  'inbox.read': NONE,
  'inbox.count': NONE,
  'inbox.unattended': NONE,
  'chat.conversations': NONE,
  'chat.messages': { conversationId: 'id' },
  'trace.read': RECORD,
  'harness.read': { runId: 'id' },
  'live_correction.read': { correctionId: 'id' },
  'automation.registry': NONE,
};
