// SPDX-License-Identifier: AGPL-3.0-only
//
// The records engine's own rules, with no database: which slot a field gets,
// which writes it refuses, and what a saved view may name.
//
// These need no Postgres because none of them is a fact about a database. The
// slot table they run against is a model of the real one, and the shape of
// that model is asserted against the migrated schema in `records-integrity`,
// so a migration that changed the slot table without changing these would be
// caught there rather than passing quietly here.

import { describe, expect, it } from 'vitest';
import {
  planSlotAssignment,
  refuseGenericWrite,
  canonicalUniqueValue,
  type FieldDefinition,
} from '../../packages/core-records/src/records/fields.ts';
import {
  isRecordsRefusal,
  type RecordsRefusal,
} from '../../packages/core-records/src/records/refusals.ts';
import type { Slot, SlotValueType } from '../../packages/core-records/src/records/slots.ts';
import { MAX_PAGE_SIZE, validateView } from '../../packages/core-records/src/records/views.ts';

/** The shipped table: 38 slots, the 16 reserved ones indexed and the 22 free ones not. */
const SLOTS: readonly Slot[] = [
  ...build('uuid', 'uuid_', 10, 6),
  ...build('text', 'txt_', 12, 6),
  ...build('timestamptz', 'ts_', 5, 2),
  ...build('numeric', 'num_', 6, 2),
  ...build('boolean', 'bool_', 5, 0),
];

function build(
  valueType: SlotValueType,
  prefix: string,
  count: number,
  reserved: number,
): readonly Slot[] {
  return Array.from({ length: count }, (_, at) => ({
    slot: `${prefix}${at + 1}`,
    valueType,
    reservation: at < reserved ? ('task_spine' as const) : null,
    indexed: at < reserved,
  }));
}

const TYPE = 'record-type';

function field(key: string, overrides: Partial<FieldDefinition> = {}): FieldDefinition {
  return {
    id: key,
    recordTypeId: TYPE,
    key,
    valueType: 'text',
    slot: null,
    writeMode: 'generic',
    owningOperation: null,
    escalatingOperation: null,
    visibilityClass: 'internal',
    searchable: false,
    uniqueValue: false,
    origin: 'core',
    deactivatedAt: null,
    ...overrides,
  };
}

/** One slot with an index, written out rather than spread, which oxlint refuses in a map. */
function indexed(slot: Slot): Slot {
  return {
    slot: slot.slot,
    valueType: slot.valueType,
    reservation: slot.reservation,
    indexed: true,
  };
}

function refusal(value: object): RecordsRefusal {
  if (!isRecordsRefusal(value)) throw new Error('expected a refusal, got a result');
  return value;
}

describe('slot assignment', () => {
  it('gives the core the reserved spine slot it names', () => {
    expect(
      planSlotAssignment({ valueType: 'uuid', origin: 'core', requestedSlot: 'uuid_1' }, SLOTS, []),
    ).toStrictEqual({ slot: 'uuid_1' });
  });

  it('refuses a preset field that names a reserved spine slot', () => {
    const result = refusal(
      planSlotAssignment(
        { valueType: 'uuid', origin: 'preset', requestedSlot: 'uuid_1' },
        SLOTS,
        [],
      ),
    );
    expect(result.code).toBe('SLOT_RESERVED');
    expect(result.names).toStrictEqual(['uuid_1', 'task_spine']);
  });

  it('refuses a slot that is not in the catalogue, because slots arrive by migration', () => {
    expect(
      refusal(
        planSlotAssignment(
          { valueType: 'uuid', origin: 'core', requestedSlot: 'uuid_99' },
          SLOTS,
          [],
        ),
      ).code,
    ).toBe('SLOT_UNKNOWN');
  });

  it('refuses a json field a slot at all', () => {
    expect(refusal(planSlotAssignment({ valueType: 'json', origin: 'core' }, SLOTS, [])).code).toBe(
      'SLOT_UNKNOWN',
    );
  });

  it('refuses a slot a deactivated field still holds, because a slot is never reused', () => {
    const held = [
      field('was_here', { valueType: 'uuid', slot: 'uuid_2', deactivatedAt: new Date() }),
    ];
    const result = refusal(
      planSlotAssignment(
        { valueType: 'uuid', origin: 'core', requestedSlot: 'uuid_2' },
        SLOTS,
        held,
      ),
    );
    expect(result.code).toBe('SLOT_TYPE_EXHAUSTED');
    expect(result.names).toContain('was_here');
  });

  it('refuses a preset field the last free slot of its type, naming the fields holding them', () => {
    const held = Array.from({ length: 5 }, (_, at) =>
      field(`flag_${at + 1}`, { valueType: 'boolean', slot: `bool_${at + 1}` }),
    );
    const result = refusal(
      planSlotAssignment({ valueType: 'boolean', origin: 'preset' }, SLOTS, held),
    );
    expect(result.code).toBe('SLOT_TYPE_EXHAUSTED');
    expect(result.names).toStrictEqual([
      'flag_1=bool_1',
      'flag_2=bool_2',
      'flag_3=bool_3',
      'flag_4=bool_4',
      'flag_5=bool_5',
    ]);
  });

  it('refuses a free slot that carries no index, rather than promising a fast field', () => {
    const result = refusal(
      planSlotAssignment({ valueType: 'boolean', origin: 'preset' }, SLOTS, []),
    );
    expect(result.code).toBe('SLOT_INDEX_ABSENT');
    expect(result.names).toStrictEqual(['bool_1', 'bool_2', 'bool_3', 'bool_4', 'bool_5']);
  });

  it('takes the lowest free indexed slot when one exists, so assignment is deterministic', () => {
    const withIndexes = SLOTS.map((slot) => (slot.slot === 'txt_7' ? indexed(slot) : slot));
    expect(
      planSlotAssignment({ valueType: 'text', origin: 'preset' }, withIndexes, []),
    ).toStrictEqual({ slot: 'txt_7' });
  });
});

describe('the generic write refusal', () => {
  const fields = [
    field('title'),
    field('state', {
      valueType: 'uuid',
      slot: 'uuid_1',
      writeMode: 'operation',
      owningOperation: 'task.complete',
    }),
    field('completed_at', { valueType: 'timestamptz', slot: 'ts_2', writeMode: 'system' }),
    field('retired', { deactivatedAt: new Date() }),
  ];

  it('allows a generic field through', () => {
    expect(refuseGenericWrite(fields, ['title'])).toBeUndefined();
  });

  it('refuses an operation-owned field, naming the operation to call instead', () => {
    const result = refusal(refuseGenericWrite(fields, ['title', 'state']) ?? {});
    expect(result.code).toBe('TRANSITION_PROTECTED');
    expect(result.names).toStrictEqual(['state=task.complete']);
  });

  it('refuses a derived field, which no operation takes as an input either', () => {
    const result = refusal(refuseGenericWrite(fields, ['completed_at']) ?? {});
    expect(result.code).toBe('FIELD_NOT_WRITABLE');
    expect(result.names).toStrictEqual(['completed_at']);
  });

  it('reports the derived field first when a payload carries both', () => {
    expect(refusal(refuseGenericWrite(fields, ['state', 'completed_at']) ?? {}).code).toBe(
      'FIELD_NOT_WRITABLE',
    );
  });

  it('refuses a field this type does not have, and one it has deactivated', () => {
    expect(refusal(refuseGenericWrite(fields, ['invented']) ?? {}).code).toBe('FIELD_UNKNOWN');
    expect(refusal(refuseGenericWrite(fields, ['retired']) ?? {}).names).toStrictEqual(['retired']);
  });
});

describe('view validation', () => {
  const fields = [
    field('title', { slot: 'txt_4' }),
    field('description'),
    field('state', { valueType: 'uuid', slot: 'uuid_1' }),
    field('priority', { valueType: 'numeric', slot: 'num_1' }),
    field('keep', { valueType: 'boolean', slot: 'bool_1' }),
  ];
  const view = {
    recordTypeId: TYPE,
    filters: [],
    sort: [],
    visibleFields: ['title', 'description'],
  };

  it('groups on a link and on a boolean', () => {
    for (const key of ['state', 'keep']) {
      expect(isRecordsRefusal(validateView({ ...view, groupBy: { field: key } }, fields))).toBe(
        false,
      );
    }
  });

  it('refuses grouping on a slotted text field, which has no bounded set of values', () => {
    const result = refusal(validateView({ ...view, groupBy: { field: 'title' } }, fields));
    expect(result.code).toBe('FIELD_NOT_GROUPABLE');
    expect(result.names).toStrictEqual(['title', 'text']);
  });

  it('refuses more than one link hop, because there are no user-defined joins', () => {
    const result = refusal(
      validateView(
        { ...view, filters: [{ field: 'title', through: ['subtask_of', 'belongs_to'] }] },
        fields,
      ),
    );
    expect(result.code).toBe('VIEW_HOP_LIMIT');
  });

  it('clamps a page size above the bound and reports the clamp', () => {
    const result = validateView({ ...view, pageSize: 5000 }, fields);
    expect(isRecordsRefusal(result)).toBe(false);
    if (isRecordsRefusal(result)) return;
    expect(result.pageSize).toBe(MAX_PAGE_SIZE);
    expect(result.clampedFrom).toBe(5000);
  });

  it('leaves a page size within the bound alone, with no clamp to report', () => {
    const result = validateView({ ...view, pageSize: 25 }, fields);
    expect(isRecordsRefusal(result) ? undefined : result.pageSize).toBe(25);
    expect(isRecordsRefusal(result) ? undefined : result.clampedFrom).toBeUndefined();
  });

  it('lets an unslotted field be shown but not filtered on', () => {
    expect(isRecordsRefusal(validateView(view, fields))).toBe(false);
    expect(
      refusal(validateView({ ...view, filters: [{ field: 'description' }] }, fields)).code,
    ).toBe('FIELD_NOT_SLOTTED');
  });
});

describe('the canonical unique value', () => {
  it('is trimmed and lower-cased, matching the schema check that stores it', () => {
    expect(canonicalUniqueValue('  Ada@Example.COM ')).toBe('ada@example.com');
  });
});
