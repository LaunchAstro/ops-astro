// SPDX-License-Identifier: AGPL-3.0-only
//
// The per-read facts, pinned as they stood at 06ab232.
//
// Written before the read facts were folded into one typed catalogue (thermo
// review b483399, H3), and green before and after. Each read's identifiers and
// whether an outsider is told NOT_FOUND are pinned by literal, and its operand
// check by the exact refusal it gives each of a set of bodies, so a
// refactor that moved a check, loosened one or changed its words fails here
// before a caller sees it. Since the catalogue landed, each fact is read off
// the read's row, and the row's spine, subject and authority mode are pinned
// beside them. The refusal order itself is pinned by
// `tests/acceptance/identifier-timing` and `identifier-negatives`.
//
// This suite moves the database counter by zero, so it is a unit suite and
// must not be named in `tests/db/named-suites.json`.

import { describe, expect, it } from 'vitest';
import { READS } from '../../packages/core-wire/src/surface.ts';
import { READ_CATALOGUE, type ReadName } from '../../packages/core-commands/src/reads/catalogue.ts';

const rows = Object.entries(READ_CATALOGUE) as [ReadName, (typeof READ_CATALOGUE)[ReadName]][];
const READ_IDENTIFIERS = Object.fromEntries(rows.map(([name, row]) => [name, row.identifiers]));
const OUTSIDER_NOT_FOUND = rows.filter(([, row]) => row.outsiderNotFound).map(([name]) => name);

/** How each read reaches its answer: spine, a resolved subject, and how authority is asked. */
const PINNED_SHAPE = {
  'map.frontier': { spine: true, subject: true, authority: 'declared' },
  'map.view': { spine: true, subject: true, authority: 'declared' },
  'access.read': { spine: false, subject: false, authority: 'declared' },
  'automation.registry': { spine: false, subject: false, authority: 'declared' },
  'client.list': { spine: false, subject: false, authority: 'holds-any-grant' },
  'connection.fleet': { spine: false, subject: false, authority: 'holds-any-grant' },
  'conversation.allowance': { spine: false, subject: false, authority: 'holds-any-grant' },
  'conversation.list': { spine: false, subject: false, authority: 'holds-any-grant' },
  'conversation.read': { spine: false, subject: false, authority: 'holds-any-grant' },
  'definition.attribution': { spine: true, subject: false, authority: 'holds-any-grant' },
  'gate.pending': { spine: true, subject: false, authority: 'holds-any-grant' },
  'harness.read': { spine: false, subject: false, authority: 'holds-any-grant' },
  'inbox.count': { spine: false, subject: false, authority: 'self' },
  'inbox.read': { spine: false, subject: false, authority: 'self' },
  'inbox.unattended': { spine: false, subject: false, authority: 'declared' },
  'live_correction.read': { spine: false, subject: false, authority: 'holds-any-grant' },
  'operations.read': { spine: false, subject: false, authority: 'declared' },
  'person.list': { spine: false, subject: false, authority: 'declared' },
  'preference.read': { spine: false, subject: false, authority: 'self' },
  'preset.plan': { spine: false, subject: false, authority: 'from the request' },
  'privacy.draft_breach_notices': { spine: false, subject: false, authority: 'declared' },
  'secret.list': { spine: false, subject: false, authority: 'holds-any-grant' },
  'session.capabilities': { spine: false, subject: false, authority: 'holds-any-grant' },
  'session.person': { spine: false, subject: false, authority: 'self' },
  'settings.read': { spine: false, subject: false, authority: 'declared' },
  'tag.list': { spine: false, subject: false, authority: 'declared' },
  'task.board': { spine: true, subject: false, authority: 'declared-within' },
  'task.execution': { spine: true, subject: true, authority: 'declared' },
  'task.queue': { spine: false, subject: false, authority: 'declared' },
  'task.read': { spine: true, subject: true, authority: 'declared' },
  'task.receipt': { spine: true, subject: true, authority: 'declared' },
  'task.todos': { spine: true, subject: false, authority: 'declared' },
  'task.search': { spine: true, subject: false, authority: 'holds-any-grant' },
  'task.ledger': { spine: true, subject: false, authority: 'declared' },
  'team.list': { spine: false, subject: false, authority: 'declared' },
  'trace.read': { spine: true, subject: true, authority: 'declared' },
};

const PINNED_IDENTIFIERS = {
  'access.read': [],
  'automation.registry': [],
  'client.list': [],
  'connection.fleet': [],
  'conversation.allowance': ['conversationId'],
  'conversation.list': [],
  'conversation.read': ['conversationId'],
  'definition.attribution': [],
  'gate.pending': [],
  'harness.read': [],
  'inbox.count': [],
  'inbox.read': [],
  'inbox.unattended': [],
  'live_correction.read': ['correctionId'],
  'map.frontier': ['recordId'],
  'map.view': ['recordId'],
  'operations.read': [],
  'person.list': [],
  'preference.read': [],
  'preset.plan': [],
  'privacy.draft_breach_notices': [],
  'secret.list': [],
  'session.capabilities': [],
  'session.person': [],
  'settings.read': [],
  'tag.list': [],
  'task.board': ['board'],
  'task.execution': ['recordId'],
  'task.ledger': [],
  'task.queue': [],
  'task.read': ['recordId'],
  'task.receipt': ['attemptId'],
  'task.search': [],
  // A teammate or a client (MP-7-2), one at a time.
  'task.todos': ['person', 'client'],
  'team.list': [],
  'trace.read': ['recordId'],
};

// MP-7-10: `team.list` is staff only; a client is told NOT_FOUND.
const PINNED_OUTSIDER_NOT_FOUND = [
  'map.frontier',
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

/** For each read, the refusal each body gets, in `BODIES` order; `null` is no refusal. */
const PINNED_OPERANDS: Readonly<Record<string, readonly unknown[]>> = {
  'map.view': BODIES.map(([label]) => (label === 'recordId string' ? null : MAP_ID)),
  'map.frontier': BODIES.map(([label]) => (label === 'recordId string' ? null : MAP_ID)),
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
  'secret.list': BODIES.map(() => null),
  'connection.fleet': BODIES.map(() => null),
  'session.capabilities': BODIES.map(() => null),
  'conversation.read': BODIES.map(() => null),
  'conversation.list': BODIES.map(() => null),
  // AW-04: an absent conversation is the empty drawer; the id is checked after the door.
  'conversation.allowance': BODIES.map(() => null),
  // AW-04: the file's digest, which none of these bodies carries.
  'definition.attribution': BODIES.map(() => ({
    code: 'FIELD_VALUE_INVALID',
    names: ['digest'],
    fixes: ['Send digest as the file’s sha-256, 64 lowercase hex characters.'],
  })),
  'session.person': BODIES.map(() => null),
  'preference.read': BODIES.map(() => null),
  'task.search': BODIES.map(() => QUERY),
  'access.read': BODIES.map(() => null),
  'operations.read': BODIES.map(() => null),
  'privacy.draft_breach_notices': BODIES.map(() => INCIDENT_ID),
  'client.list': BODIES.map(() => null),
  'inbox.read': BODIES.map(() => null),
  'inbox.count': BODIES.map(() => null),
  'inbox.unattended': BODIES.map(() => null),
  // C80's correction and AW-12's run, which none of these bodies carries.
  'live_correction.read': BODIES.map(() => ({
    code: 'FIELD_VALUE_INVALID',
    names: ['correctionId'],
    fixes: ['Send correctionId as the correction.'],
  })),
  'harness.read': BODIES.map(() => ({
    code: 'FIELD_VALUE_INVALID',
    names: ['runId'],
    fixes: ['Send runId as the run’s identifier.'],
  })),
};

/** The refusal without its `refused` flag, or null. */
function answerOf(read: ReadName, body: Readonly<Record<string, unknown>>): unknown {
  const parsed = READ_CATALOGUE[read].parse(body);
  if (parsed.ok) return null;
  const { refusal } = parsed;
  return { code: refusal.code, names: refusal.names, fixes: refusal.fixes };
}

describe('the per-read facts at 06ab232', () => {
  it('names the same thirty-six reads', () => {
    expect([...READS].toSorted()).toStrictEqual(Object.keys(PINNED_IDENTIFIERS));
  });

  it('takes the same identifiers on each read', () => {
    expect({ ...READ_IDENTIFIERS }).toStrictEqual(PINNED_IDENTIFIERS);
  });

  it('tells an outsider NOT_FOUND on the same six', () => {
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
