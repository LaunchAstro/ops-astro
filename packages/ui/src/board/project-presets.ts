// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's presets and its Review mode (MP-5-12). The viewer
// preset narrows to the signed-in person's own tasks and is on at load
// agency-wide (P-11); a client's board opens without it. A category chip is
// offered only for a category some row in scope has (P-13, M-04), and it is
// flagged, never counted, when a client or a mention waits in it. Review
// narrows the table to the tasks waiting at a gate for the viewer's decision
// and drops every assignee filter as it opens (P-10, `gateRule`); the queue's
// own cards are MP-8-1's.
//
// Every chip is built from the rows the reader was handed, so none names a
// person or category outside the reader's scope.

import type { Preset, RowMode } from './types.ts';
import type { ProjectRow } from './project-row.ts';
import { categorySlug, viewerFacetId } from './project-facets.ts';

export const REVIEW_MODE: RowMode<ProjectRow> = {
  id: 'review',
  label: 'Review',
  drops: ['Assignee'],
  narrow: (row) => row.awaitingDecision,
};

const WAITING = 'A client or a mention is waiting here';

const attention = (row: ProjectRow): boolean =>
  row.comments.client > 0 || row.comments.mentions > 0;

/** The viewer's chip, then one chip per category in scope, by name. */
export function projectPresets(
  rows: readonly ProjectRow[],
  viewer: string | null,
): readonly Preset[] {
  const categories = [...new Set(rows.map((row) => row.category))]
    .filter((category): category is string => category !== null)
    .toSorted();
  const chips = categories.map((category): Preset => {
    const flagged = rows.some((row) => row.category === category && attention(row));
    const chip: Preset = {
      id: `cat-${categorySlug(category)}`,
      label: category,
      icon: 'tag',
      facetIds: [`category:${categorySlug(category)}`],
      uncounted: true,
      variant: 'cat',
    };
    return flagged ? Object.assign(chip, { flag: WAITING }) : chip;
  });
  if (viewer === null) return chips;
  const own = rows.find((row) => row.assignee?.id === viewer)?.assignee?.name;
  return [
    {
      id: `who-${viewer}`,
      label: own ?? 'Mine',
      variant: 'viewer',
      facetIds: [viewerFacetId(viewer)],
    },
    ...chips,
  ];
}

/** The address a board opens on: the viewer preset on when it names no filter. */
export function openWithViewer(address: string, viewer: string | null): string {
  const params = new URLSearchParams(address.startsWith('?') ? address.slice(1) : address);
  if (viewer === null || params.has('f')) return params.toString();
  params.set('f', viewerFacetId(viewer));
  return params.toString();
}

/**
 * The Review chip's live count and what it says: `owed`, INB-1's one count
 * (MP-5-12), when the read sent it, else the rows waiting on the viewer's gate.
 */
export function reviewBadge(
  rows: readonly ProjectRow[],
  owed?: number,
): {
  readonly count: number;
  readonly title: string;
} {
  if (owed !== undefined) {
    return {
      count: owed,
      title: owed === 0 ? 'Nothing waiting for you' : `${String(owed)} waiting for you`,
    };
  }
  const count = rows.filter((row) => row.awaitingDecision).length;
  return {
    count,
    title: count === 0 ? 'Nothing waiting on your gate' : `${String(count)} waiting on your gate`,
  };
}
