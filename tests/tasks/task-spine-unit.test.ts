// SPDX-License-Identifier: AGPL-3.0-only
//
// The spine declaration, checked without a database.
//
// `spine.ts` is the one place the task type is stated, and every other
// assertion in this part reads the database back against it. So the
// declaration itself has to be checked against the contracts it transcribes,
// or a typo in the list becomes the thing the conformance set faithfully
// confirms.
//
// These cases need no server and run in every environment, including one with
// no `DATABASE_URL`, which is the point: a suite that proves nothing without a
// database proves nothing in continuous integration until somebody wires one.

import { describe, expect, it } from 'vitest';
import {
  CONDITIONAL_TASK_FIELDS,
  FIELDS_NOT_CARRIED,
  PROTECTED_TASK_FIELDS,
  TASK_SPINE,
  slotOf,
} from '../../packages/core-records/src/tasks/spine.ts';
import {
  MACHINE_CATEGORIES,
  TASK_STATE_FIELDS,
  TASK_STATE_SEED,
} from '../../packages/core-records/src/tasks/states.ts';
import {
  completionStampFor,
  deriveSource,
  mergeFieldValues,
  RANK_GAP,
} from '../../packages/core-records/src/tasks/placement.ts';
import { RETENTION_CLASS_BY_TABLE } from '../../packages/core-records/src/tasks/trash.ts';

describe('the spine declaration', () => {
  // Fixed slots 2.2, transcribed. If this list and that table disagree, the
  // reservation in migration 0004 is reserving slots for fields that are not
  // in them.
  const RESERVATION_ORDER: readonly (readonly [string, string])[] = [
    ['uuid_1', 'state'],
    ['uuid_2', 'assignee'],
    ['uuid_3', 'delegate'],
    ['uuid_4', 'parent'],
    ['uuid_5', 'board'],
    ['uuid_6', 'board_section'],
    ['txt_1', 'key'],
    ['txt_2', 'source'],
    ['txt_3', 'intake_state'],
    ['txt_4', 'title'],
    ['txt_5', 'stage'],
    ['txt_6', 'lane'],
    ['ts_1', 'due'],
    ['ts_2', 'completed_at'],
    ['num_1', 'priority'],
    ['num_2', 'board_rank'],
  ];

  it('places the sixteen reserved slots in the order the contract fixes', () => {
    for (const [slot, key] of RESERVATION_ORDER) {
      expect(slotOf(TASK_SPINE, key)).toBe(slot);
    }
  });

  it('adds exactly two slots beyond that sixteen, both protected', () => {
    const beyond = TASK_SPINE.filter(
      (field) => field.slot !== null && !RESERVATION_ORDER.some(([slot]) => slot === field.slot),
    );
    expect(beyond.map((field) => `${field.key}=${field.slot ?? ''}`)).toStrictEqual([
      'client=uuid_7',
      'client_visible=bool_1',
    ]);
    expect(beyond.every((field) => field.writeMode !== 'generic')).toBe(true);
  });

  it('gives every field a classification and no field two slots', () => {
    const slots = TASK_SPINE.map((field) => field.slot).filter((slot) => slot !== null);
    expect(new Set(slots).size).toBe(slots.length);
    expect(new Set(TASK_SPINE.map((field) => field.key)).size).toBe(TASK_SPINE.length);
    for (const field of TASK_SPINE) {
      expect(['generic', 'operation', 'system']).toContain(field.writeMode);
      // The schema's own equality, restated where the rows are written: an
      // operation-owned field names one and nothing else does.
      expect(field.owningOperations.length > 0).toBe(field.writeMode === 'operation');
    }
  });

  it('names the protected set as exactly the fields that are not generic', () => {
    const notGeneric = TASK_SPINE.filter((field) => field.writeMode !== 'generic')
      .map((field) => field.key)
      .toSorted();
    expect([...PROTECTED_TASK_FIELDS].toSorted()).toStrictEqual(notGeneric);
  });

  it('escalates on the two containment fields and nowhere else', () => {
    const escalating = TASK_SPINE.filter((field) => field.escalatingOperation !== null)
      .map((field) => field.key)
      .toSorted();
    expect(escalating).toStrictEqual([...CONDITIONAL_TASK_FIELDS].toSorted());
    for (const key of CONDITIONAL_TASK_FIELDS) {
      const field = TASK_SPINE.find((candidate) => candidate.key === key);
      expect(field?.escalatingOperation).toBe('task.move');
      expect(field?.writeMode).toBe('generic');
    }
  });

  it('carries none of the fields the new core dropped', () => {
    for (const key of FIELDS_NOT_CARRIED) {
      expect(TASK_SPINE.some((field) => field.key === key)).toBe(false);
    }
  });

  it('shapes every operation name the way the schema constrains it', () => {
    const shape = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*( [a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)*$/u;
    for (const field of [...TASK_SPINE, ...TASK_STATE_FIELDS]) {
      if (field.owningOperations.length > 0) {
        expect(field.owningOperations.join(' ')).toMatch(shape);
        for (const name of field.owningOperations) expect(name).not.toContain(' ');
      }
      if (field.escalatingOperation !== null) {
        expect(field.escalatingOperation).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u);
      }
    }
    // The one field with more than one owner, which is why the column holds a
    // list at all.
    expect(TASK_SPINE.find((field) => field.key === 'state')?.owningOperations).toStrictEqual([
      'task.complete',
      'task.reopen',
      'task.start',
    ]);
  });

  it('seeds the legacy’s five words, every one inside the five categories', () => {
    // ADR 0011:30 records them verbatim. They are preset data mapped onto the
    // machine categories, never core states, so the labels are the assertion.
    expect(TASK_STATE_SEED.map((seed) => seed.label)).toStrictEqual([
      'Needs review',
      'Active',
      'Waiting on client',
      'On hold',
      'Complete',
    ]);
    for (const seed of TASK_STATE_SEED) {
      expect(MACHINE_CATEGORIES).toContain(seed.machineCategory);
    }
    // Four of the five. The Hub had no cancelled word, and an installation
    // seeded from this set cannot reach that category until a preset adds one.
    expect(new Set(TASK_STATE_SEED.map((seed) => seed.machineCategory))).toStrictEqual(
      new Set(['unstarted', 'started', 'backlog', 'completed']),
    );
    // Positions are spaced, so a preset can insert a state between two without
    // renumbering the ones an installation already draws.
    const positions = TASK_STATE_SEED.map((seed) => seed.position);
    expect(positions).toStrictEqual([...positions].toSorted((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('refuses to name a slot for a field that has none', () => {
    expect(() => slotOf(TASK_SPINE, 'description')).toThrow(/not a slotted field/u);
    expect(() => slotOf(TASK_SPINE, 'nothing_like_it')).toThrow(/not a slotted field/u);
  });
});

describe('the derivations a request body cannot supply', () => {
  it('stamps a completion only for the completed category', () => {
    const now = new Date('2026-09-11T04:00:00Z');
    expect(completionStampFor('completed', now)).toBe(now);
    for (const category of MACHINE_CATEGORIES.filter((each) => each !== 'completed')) {
      expect(completionStampFor(category, now)).toBeNull();
    }
    // An unrecognised state still answers, and answers "not completed" rather
    // than throwing: an unknown state prints, it does not stop the product.
    expect(completionStampFor('something_a_preset_invented', now)).toBeNull();
  });

  it('derives source from the actor kind and the entry point, and nothing else', () => {
    expect(deriveSource('person', 'app')).toBe('person:app');
    expect(deriveSource('agent', 'cli')).toBe('agent:cli');
    expect(deriveSource('system', 'automation')).toBe('system:automation');
  });

  it('tells "clear the due date" from "do not change the due date"', () => {
    const existing = { title: 'a task', due: '2026-09-30T00:00:00Z', lane: 'delivery' };
    // Absent from the payload: kept.
    expect(mergeFieldValues(existing, { title: 'renamed' })).toStrictEqual({
      title: 'renamed',
      due: '2026-09-30T00:00:00Z',
      lane: 'delivery',
    });
    // Explicitly null: cleared, and the key stops being carried at all.
    const cleared = mergeFieldValues(existing, { due: null });
    expect(cleared).not.toHaveProperty('due');
    expect(cleared['lane']).toBe('delivery');
    // Clearing something that was never there is not an error and adds nothing.
    expect(mergeFieldValues({ title: 'a' }, { due: null })).toStrictEqual({ title: 'a' });
    // The existing record is not modified.
    expect(existing['due']).toBe('2026-09-30T00:00:00Z');
  });

  it('spaces ranks so a task can be put between two others repeatedly', () => {
    // How many times `task.rank` can halve the gap before two neighbours are
    // one apart and a re-spacing pass is the only move left. Counted rather
    // than asserted as arithmetic, so the number is a property of the constant
    // and not a restatement of it.
    let gap = RANK_GAP;
    let halvings = 0;
    while (gap > 1) {
      gap /= 2;
      halvings += 1;
    }
    expect(halvings).toBeGreaterThanOrEqual(9);
  });
});

describe('the retention register', () => {
  it('classifies the evidence tables before they exist', () => {
    expect(RETENTION_CLASS_BY_TABLE['audit_events']).toBe('evidence');
    expect(RETENTION_CLASS_BY_TABLE['gate_decisions']).toBe('evidence');
  });

  it('puts only the record tables in the purgeable class', () => {
    const work = Object.entries(RETENTION_CLASS_BY_TABLE)
      .filter(([, retention]) => retention === 'work')
      .map(([table]) => table)
      .toSorted();
    expect(work).toStrictEqual(['record_links', 'record_unique_values', 'records']);
  });
});
