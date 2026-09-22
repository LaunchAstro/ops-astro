// SPDX-License-Identifier: AGPL-3.0-only
//
// The view validator: the half of `slot_law` that is not the trigger.
//
// A saved view names a record type, a filter, a sort, an optional grouping, a
// visible field list, a page size and an owner. Filter, sort and group may name
// only slotted fields, and a view naming a non-slotted field is refused at save
// time rather than silently downgraded to a display column (fixed slots, 5.1).
//
// The same validation runs at read time, because a field can be deactivated
// after a view was saved. A view that quietly reorders itself because the field
// it sorted on stopped existing is worse than one that refuses: the reader has
// no way to tell a different answer from a wrong one.

import { isLive, type FieldDefinition } from './fields.ts';
import { refuse, type RecordsRefusal } from './refusals.ts';

/** Page size is bounded, not optional (E19:363). A larger request is clamped and told so. */
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export interface ViewClause {
  /** The field key this clause names. */
  readonly field: string;
  /**
   * Link types traversed to reach the field. Traversal is one hop through a
   * defined link type; there are no user-defined joins (E19 law 5).
   */
  readonly through?: readonly string[];
}

export interface ViewDefinition {
  readonly recordTypeId: string;
  readonly filters: readonly ViewClause[];
  readonly sort: readonly ViewClause[];
  readonly groupBy?: ViewClause;
  /** Display only. A visible field needs no slot, which is the whole point of `data`. */
  readonly visibleFields: readonly string[];
  readonly pageSize?: number;
}

export interface ValidatedView {
  readonly view: ViewDefinition;
  readonly pageSize: number;
  /**
   * Present when the requested page size was above the bound. The clamp is
   * reported rather than applied in silence: a silently truncated list is the
   * legacy's recorded trap (fixed slots, 5.3 D2).
   */
  readonly clampedFrom?: number;
}

/**
 * Grouping needs a bounded set of values. This model has no `select` type; what
 * it has instead is a uuid slot holding a link to a record of another type —
 * which is exactly how board grouping works, reading the machine category off
 * the state record (specification, 14.5) — and booleans. Free text, numbers and
 * timestamps are not groupable, and saying so is E19:361's rule in the terms
 * this design actually has.
 */
const GROUPABLE = new Set(['uuid', 'boolean']);

export function validateView(
  view: ViewDefinition,
  fields: readonly FieldDefinition[],
): ValidatedView | RecordsRefusal {
  const live = new Map(
    fields
      .filter((field) => isLive(field) && field.recordTypeId === view.recordTypeId)
      .map((field) => [field.key, field]),
  );

  const clauses: readonly { readonly clause: ViewClause; readonly where: string }[] = [
    ...view.filters.map((clause) => ({ clause, where: 'filter' })),
    ...view.sort.map((clause) => ({ clause, where: 'sort' })),
    ...(view.groupBy === undefined ? [] : [{ clause: view.groupBy, where: 'grouping' }]),
  ];

  for (const { clause, where } of clauses) {
    const hops = clause.through ?? [];
    if (hops.length > 1) {
      return refuse(
        'VIEW_HOP_LIMIT',
        [clause.field, ...hops],
        [
          `A ${where} may traverse one link type. There are no user-defined joins.`,
          'Model the value you need on the record, or read the linked record separately.',
        ],
      );
    }
    // A traversed clause names a field on the record at the far end of the
    // hop, which this record type's definitions cannot vouch for. The one hop
    // is permitted; validating the far field is the retrieval capability's,
    // and until it exists a traversed clause is not accepted here.
    if (hops.length === 1) {
      return refuse(
        'VIEW_HOP_LIMIT',
        [clause.field, ...hops],
        [
          'Traversal through a link type is not yet validated by the records engine.',
          'Filter, sort and group on the slotted fields this record type owns.',
        ],
      );
    }

    const field = live.get(clause.field);
    if (field === undefined) {
      return refuse(
        'FIELD_UNKNOWN',
        [clause.field],
        [
          `This record type has no live field named ${clause.field}.`,
          'A view saved before the field was deactivated is refused at read, not reordered.',
        ],
      );
    }
    if (field.slot === null) {
      return refuse(
        'FIELD_NOT_SLOTTED',
        [clause.field],
        [
          `${clause.field} has no slot, so it cannot be used as a ${where}.`,
          'Give the field a slot, or use it as a visible field only.',
        ],
      );
    }
    if (where === 'grouping' && !GROUPABLE.has(field.valueType)) {
      return refuse(
        'FIELD_NOT_GROUPABLE',
        [clause.field, field.valueType],
        [
          'Grouping needs a bounded set of values: a link to another record, or a boolean.',
          `${clause.field} is ${field.valueType}, which has no bounded set to group by.`,
        ],
      );
    }
  }

  const requested = view.pageSize ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requested, MAX_PAGE_SIZE);
  return requested > MAX_PAGE_SIZE
    ? { view, pageSize, clampedFrom: requested }
    : { view, pageSize };
}
