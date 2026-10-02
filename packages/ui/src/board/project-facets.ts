// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's facets (MP-5-8, B-06): the facts of the rows a person
// can filter by, built only from the rows the reader was handed, so no facet
// names a client, person or stage outside the reader's scope.

import type { Facet } from './types.ts';
import type { ProjectRow } from './project-row.ts';
import { pad } from './project-words.ts';

/**
 * A facet's id: its kind, then the exact value in quotes, with `%` and the
 * address's `,` escaped. Two values are never one id, whatever their script or
 * punctuation (REVIEW-2C1-4), and no id here has the shape of the earlier
 * slugged ids (`client:smith-co`), so an address saved with one of those
 * matches nothing and is dropped on the way in, never read as another client.
 */
export const facetId = (kind: string, value: string): string =>
  `${kind.toLowerCase()}:"${value.replaceAll('%', '%25').replaceAll(',', '%2C')}"`;

const wordsOf = (value: string): readonly string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word !== '');

function byField(
  kind: string,
  rows: readonly ProjectRow[],
  of: (row: ProjectRow) => string | null,
  offered: readonly string[] = [],
): readonly Facet<ProjectRow>[] {
  const values = [...new Set([...rows.map((row) => of(row)), ...offered])]
    .filter((value): value is string => value !== null)
    .toSorted();
  return values.map((value) => {
    return {
      id: facetId(kind, value),
      kind,
      label: value,
      words: wordsOf(value),
      test: (row: ProjectRow) => of(row) === value,
    };
  });
}

/** The Client filter on one client, by name: the address a Clients row door opens the board at. */
export const clientFacetId = (name: string): string => facetId('client', name);

/** The assignee filter on one person (the viewer preset's, P-11). */
export const viewerFacetId = (person: string): string => `assignee:${person}`;

/**
 * One filter per person assigned, keyed on the person (two people of one name
 * are two filters), and the viewer's own even when no row is theirs, so the
 * viewer preset is on and empty rather than unknown.
 */
function byAssignee(
  rows: readonly ProjectRow[],
  viewer: string | null,
): readonly Facet<ProjectRow>[] {
  const people = new Map<string, string>();
  for (const row of rows) if (row.assignee !== null) people.set(row.assignee.id, row.assignee.name);
  if (viewer !== null && !people.has(viewer)) people.set(viewer, 'Mine');
  return [...people]
    .toSorted(([a, left], [b, right]) => left.localeCompare(right) || a.localeCompare(b))
    .map(([person, name]) => ({
      id: viewerFacetId(person),
      kind: 'Assignee',
      label: name,
      words: wordsOf(name),
      test: (row: ProjectRow) => row.assignee?.id === person,
    }));
}

/**
 * The facets these rows offer: client, assignee, stage, status, category and
 * overdue. `viewer` is the signed-in person, whose filter is always offered.
 * `clients` are the names of the clients the reader reaches (`client.list`),
 * each offered even with no row of theirs, so a Clients row door to a quiet
 * client opens on no task rather than on every client's work.
 */
export function projectFacets(
  rows: readonly ProjectRow[],
  now: Date,
  viewer: string | null = null,
  clients: readonly string[] = [],
): readonly Facet<ProjectRow>[] {
  // The reader's own calendar day, as the due cell judges it (never the UTC day).
  const today = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return [
    ...byField('Client', rows, (row) => row.client, clients),
    ...byAssignee(rows, viewer),
    ...byField('Stage', rows, (row) => row.stage),
    ...byField('Status', rows, (row) => row.status),
    ...byField('Category', rows, (row) => row.category),
    {
      id: 'due:overdue',
      kind: 'Due',
      label: 'Overdue',
      words: ['overdue', 'late'],
      test: (row) => !row.completed && row.due !== null && row.due.slice(0, 10) < today,
    },
  ];
}

/**
 * How many client filters an address has on (the Client column's rule, P-23).
 * An earlier slugged id is no filter: the board drops it, so it hides no column.
 */
export function clientFiltersIn(address: string): number {
  const ids = new URLSearchParams(address.startsWith('?') ? address.slice(1) : address).get('f');
  return (ids ?? '').split(',').filter((id) => /^client:".*"$/u.test(id)).length;
}
