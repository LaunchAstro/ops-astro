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
import { READS } from '../../packages/core-records/src/commands/surface.ts';
import { READ_CATALOGUE, type ReadName } from '../../packages/core-records/src/reads/catalogue.ts';

const rows = Object.entries(READ_CATALOGUE) as [ReadName, (typeof READ_CATALOGUE)[ReadName]][];
const READ_IDENTIFIERS = Object.fromEntries(rows.map(([name, row]) => [name, row.identifiers]));
const OUTSIDER_NOT_FOUND = rows.filter(([, row]) => row.outsiderNotFound).map(([name]) => name);

/** How each read reaches its answer: spine, a resolved subject, and how authority is asked. */
const PINNED_SHAPE = {
  'person.list': { spine: false, subject: false, authority: 'declared' },
  'preset.plan': { spine: false, subject: false, authority: 'from the request' },
  'session.capabilities': { spine: false, subject: false, authority: 'holds-any-grant' },
  'settings.read': { spine: false, subject: false, authority: 'declared' },
  'task.board': { spine: true, subject: false, authority: 'declared' },
  'task.queue': { spine: false, subject: false, authority: 'declared' },
  'task.read': { spine: true, subject: true, authority: 'declared' },
};

const PINNED_IDENTIFIERS = {
  'person.list': [],
  'preset.plan': [],
  'session.capabilities': [],
  'settings.read': [],
  'task.board': ['board'],
  'task.queue': [],
  'task.read': ['recordId'],
};

const PINNED_OUTSIDER_NOT_FOUND = ['task.board', 'task.read'];

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
const BOARD = {
  code: 'FIELD_VALUE_INVALID',
  names: ['board'],
  fixes: ['Send board as a board task’s identifier, or null for tasks on no board.'],
};
const plan = (name: string) => ({
  code: 'FIELD_VALUE_INVALID',
  names: [name],
  fixes: [`Send ${name} as a non-empty string.`],
});
const PLAN_FIELDS = {
  code: 'FIELD_VALUE_INVALID',
  names: ['fields'],
  fixes: ['Send fields as an array of field objects, which may be empty.'],
};

/** For each read, the refusal each body gets, in `BODIES` order; `null` is no refusal. */
const PINNED_OPERANDS: Readonly<Record<string, readonly unknown[]>> = {
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
  'person.list': BODIES.map(() => null),
  'settings.read': BODIES.map(() => null),
  'session.capabilities': BODIES.map(() => null),
};

/** The refusal without its `refused` flag, or null. */
function answerOf(read: ReadName, body: Readonly<Record<string, unknown>>): unknown {
  const parsed = READ_CATALOGUE[read].parse(body);
  if (parsed.ok) return null;
  const { refusal } = parsed;
  return { code: refusal.code, names: refusal.names, fixes: refusal.fixes };
}

describe('the per-read facts at 06ab232', () => {
  it('names the same seven reads', () => {
    expect([...READS].toSorted()).toStrictEqual(Object.keys(PINNED_IDENTIFIERS));
  });

  it('takes the same identifiers on each read', () => {
    expect({ ...READ_IDENTIFIERS }).toStrictEqual(PINNED_IDENTIFIERS);
  });

  it('tells an outsider NOT_FOUND on the same two', () => {
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
