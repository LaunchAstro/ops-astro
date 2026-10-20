// SPDX-License-Identifier: AGPL-3.0-only
//
// The per-read facts, pinned as they stood at 06ab232.
//
// Written before the read facts were folded into one typed catalogue (thermo review b483399, H3),
// and green before and after. Identifiers and whether an outsider is told NOT_FOUND are pinned by
// literal, and each operand check by the exact refusal it gives each body, so a refactor that
// moved, loosened or reworded a check fails here first. Since the catalogue landed, each fact is
// read off the read's row, with the row's spine, subject and authority mode pinned beside them.
// The refusal order is pinned by `tests/acceptance/identifier-timing` and `identifier-negatives`.
//
// It moves the database counter by zero: a unit suite, never in `tests/db/named-suites.json`.

import { describe, expect, it } from 'vitest';
import { READS } from '../../packages/core-wire/src/surface.ts';
import { READ_CATALOGUE, type ReadName } from '../../packages/core-commands/src/reads/catalogue.ts';
import { PINNED_IDENTIFIERS, PINNED_SHAPE } from './read-catalogue-shape.ts';

const rows = Object.entries(READ_CATALOGUE) as [ReadName, (typeof READ_CATALOGUE)[ReadName]][];
const READ_IDENTIFIERS = Object.fromEntries(rows.map(([name, row]) => [name, row.identifiers]));
const OUTSIDER_NOT_FOUND = rows.filter(([, row]) => row.outsiderNotFound).map(([name]) => name);

// MP-7-10: `team.list` is staff only; a client is told NOT_FOUND. So are
// C71-D's two conversation reads.
const PINNED_OUTSIDER_NOT_FOUND = [
  'chat.conversations',
  'chat.messages',
  'map.frontier',
  'map.list',
  'map.view',
  'task.board',
  'task.execution',
  'task.ledger',
  'task.read',
  'task.receipt',
  'team.list',
  'trace.read',
];

const BODIES: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
  ['empty', {}],
  ['recordId string', { recordId: 'T-1' }],
  ['recordId number', { recordId: 7 }],
  ['board null', { board: null }],
  ['board string', { board: 'b' }],
  ['board number', { board: 1 }],
  ['plan complete', { recordTypeKey: 'task', presetKey: 'p', fields: [] }],
  ['plan empty key', { recordTypeKey: '', presetKey: 'p', fields: [] }],
  ['plan no preset', { recordTypeKey: 'task', fields: [] }],
  ['plan fields object', { recordTypeKey: 'task', presetKey: 'p', fields: {} }],
  ['plan fields of non-objects', { recordTypeKey: 'task', presetKey: 'p', fields: [1] }],
];

const RECORD_ID = {
  code: 'FIELD_VALUE_INVALID',
  names: ['recordId'],
  fixes: ['Send recordId as the task’s identifier or its key.'],
};
const MAP_ID = {
  code: 'FIELD_VALUE_INVALID',
  names: ['recordId'],
  fixes: ['Send recordId as the map’s identifier or its key.'],
};
const BOARD = {
  code: 'FIELD_VALUE_INVALID',
  names: ['board'],
  fixes: ['Send board as a board task’s identifier, or null for tasks on no board.'],
};
const QUERY = {
  code: 'FIELD_VALUE_INVALID',
  names: ['query'],
  fixes: ['Send query as up to 200 characters with a word in them.'],
};
const plan = (name: string) => ({
  code: 'FIELD_VALUE_INVALID',
  names: [name],
  fixes: [`Send ${name} as a non-empty string.`],
});
const INCIDENT_ID = {
  code: 'FIELD_VALUE_INVALID',
  names: ['incidentId'],
  fixes: ['Send incidentId as the id of a privacy incident.'],
};
const PLAN_FIELDS = {
  code: 'FIELD_VALUE_INVALID',
  names: ['fields'],
  fixes: ['Send fields as an array of field objects, which may be empty.'],
};

/** None of the bodies names a zone, so the ledger refuses each for that first. */
const LEDGER_ZONE = {
  code: 'FIELD_VALUE_INVALID',
  names: ['timeZone'],
  fixes: ['Send timeZone as a zone name the server knows, such as Australia/Brisbane.'],
};

/** The one refusal every body gets for an operand none of them carries. */
const unsent = (name: string, fix: string) =>
  BODIES.map(() => ({ code: 'FIELD_VALUE_INVALID', names: [name], fixes: [fix] }));

/** For each read, the refusal each body gets, in `BODIES` order; `null` is no refusal. */
const PINNED_OPERANDS: Readonly<Record<string, readonly unknown[]>> = {
  'map.view': BODIES.map(([label]) => (label === 'recordId string' ? null : MAP_ID)),
  'map.frontier': BODIES.map(([label]) => (label === 'recordId string' ? null : MAP_ID)),
  'map.list': BODIES.map(() => null),
  'task.read': [
    RECORD_ID,
    null,
    RECORD_ID,
    RECORD_ID,
    RECORD_ID,
    RECORD_ID,
    RECORD_ID,
    RECORD_ID,
    RECORD_ID,
    RECORD_ID,
    RECORD_ID,
  ],
  'task.board': [BOARD, BOARD, BOARD, null, null, BOARD, BOARD, BOARD, BOARD, BOARD, BOARD],
  // T2a: `task.read`'s recordId check; an absent cursor is the start.
  'task.execution': BODIES.map(([name]) => (name === 'recordId string' ? null : RECORD_ID)),
  // AW-13 readers: the task, as `task.execution` takes it.
  'trace.read': BODIES.map(([name]) => (name === 'recordId string' ? null : RECORD_ID)),
  // T2c2: the receipt is named by its attempt, which none of these bodies carries.
  'task.receipt': BODIES.map(() => ({
    code: 'FIELD_VALUE_INVALID',
    names: ['attemptId'],
    fixes: ['Send attemptId as the observed attempt.'],
  })),
  'task.ledger': BODIES.map(() => LEDGER_ZONE),
  'team.list': BODIES.map(() => null),
  'preset.plan': [
    plan('recordTypeKey'),
    plan('recordTypeKey'),
    plan('recordTypeKey'),
    plan('recordTypeKey'),
    plan('recordTypeKey'),
    plan('recordTypeKey'),
    null,
    plan('recordTypeKey'),
    plan('presetKey'),
    PLAN_FIELDS,
    PLAN_FIELDS,
  ],
  'task.queue': BODIES.map(() => null),
  'gate.pending': BODIES.map(() => null),
  'person.list': BODIES.map(() => null),
  'tag.list': BODIES.map(() => null),
  'task.todos': BODIES.map(() => null),
  'settings.read': BODIES.map(() => null),
  // C33: the Workflow triggers registry takes nothing.
  'automation.registry': BODIES.map(() => null),
  // An activation's history (#1741), named by the activation, which none of these bodies carries.
  'automation.history': unsent('activationId', 'Send activationId as the activation’s identifier.'),
  'secret.list': BODIES.map(() => null),
  'connection.fleet': BODIES.map(() => null),
  'connection.signal': BODIES.map(() => null),
  'connection.graduation': BODIES.map(() => null),
  'finance.skill_costs': BODIES.map(() => null),
  // The cost log's period, which none of these bodies carries.
  'finance.agent_costs': BODIES.map(() => ({
    code: 'FIELD_VALUE_INVALID',
    names: ['from'],
    fixes: ['Send from and to as ISO date-times, from before to.'],
  })),
  'session.capabilities': BODIES.map(() => null),
  'conversation.read': BODIES.map(() => null),
  'conversation.list': BODIES.map(() => null),
  // AW-04: an absent conversation is the empty drawer; the id is checked after the door.
  'conversation.allowance': BODIES.map(() => null),
  // CS-7.30: the same, for the picker's offer.
  'conversation.models': BODIES.map(() => null),
  // AW-04: the file's digest, which none of these bodies carries.
  'definition.attribution': BODIES.map(() => ({
    code: 'FIELD_VALUE_INVALID',
    names: ['digest'],
    fixes: ['Send digest as the file’s sha-256, 64 lowercase hex characters.'],
  })),
  'session.person': BODIES.map(() => null),
  'preference.read': BODIES.map(() => null),
  'agent.mine': BODIES.map(() => null),
  'task.search': BODIES.map(() => QUERY),
  'access.read': BODIES.map(() => null),
  'operations.read': BODIES.map(() => null),
  'privacy.draft_breach_notices': BODIES.map(() => INCIDENT_ID),
  'client.list': BODIES.map(() => null),
  'inbox.read': BODIES.map(() => null),
  'inbox.count': BODIES.map(() => null),
  'inbox.unattended': BODIES.map(() => null),
  // C80's correction, which none of these bodies carries.
  'live_correction.read': unsent('correctionId', 'Send correctionId as the correction.'),
  // #1694: the list takes nothing; the receipts read takes the correction.
  'live_correction.list': BODIES.map(() => null),
  'live_correction.receipts': unsent('correctionId', 'Send correctionId as the correction.'),
  // C35's review, which none of these bodies carries.
  'review.read': unsent('reviewId', 'Send reviewId as the review.'),
  'review.list': BODIES.map(() => null),
  'review.picture': unsent('pictureId', 'Send pictureId as the landed picture.'),
  'review.client_list': BODIES.map(() => null),
  // C71-D: a conversation is named by its id, which none of these bodies carries.
  'chat.conversations': BODIES.map(() => null),
  'chat.messages': unsent('conversationId', 'Send conversationId as a conversation’s identifier.'),
  'invitation.list': BODIES.map(() => null),
};

/** The refusal without its `refused` flag, or null. */
function answerOf(read: ReadName, body: Readonly<Record<string, unknown>>): unknown {
  const parsed = READ_CATALOGUE[read].parse(body);
  if (parsed.ok) return null;
  const { refusal } = parsed;
  return { code: refusal.code, names: refusal.names, fixes: refusal.fixes };
}

describe('the per-read facts at 06ab232', () => {
  it('names the same forty-eight reads', () => {
    expect([...READS].toSorted()).toStrictEqual(Object.keys(PINNED_IDENTIFIERS));
  });

  it('takes the same identifiers on each read', () => {
    expect({ ...READ_IDENTIFIERS }).toStrictEqual(PINNED_IDENTIFIERS);
  });

  it('tells an outsider NOT_FOUND on the same twelve', () => {
    expect([...OUTSIDER_NOT_FOUND].toSorted()).toStrictEqual(PINNED_OUTSIDER_NOT_FOUND);
  });

  it('reaches each answer the same way', () => {
    const shape = Object.fromEntries(
      rows
        .map(([name, row]) => [
          name,
          {
            spine: row.spine,
            subject: row.spine && row.subject !== undefined,
            authority: typeof row.authority === 'function' ? 'from the request' : row.authority,
          },
        ])
        .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
    );
    expect(shape).toStrictEqual(PINNED_SHAPE);
  });

  it.each(rows.map(([name]) => name))('checks the operands of %s the same way', (read) => {
    expect(BODIES.map(([, body]) => answerOf(read, body))).toStrictEqual(PINNED_OPERANDS[read]);
  });
});
