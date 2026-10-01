// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-4, red proof: two clients whose names slug alike share one
// facet id (`project-facets.ts` slugs every run outside [a-z0-9] to '-'), and
// `narrowRows` takes the first facet with an id, so narrowing on the second
// client shows the first client's rows. Fixed when every facet id is unique
// and each narrows to its own client. Synthetic rows only.

import { describe, expect, it } from 'vitest';
import { narrowRows } from '../../packages/ui/src/board/filters.ts';
import { projectFacets } from '../../packages/ui/src/board/project-facets.ts';
import type { ProjectRow } from '../../packages/ui/src/board/projects.ts';

const NOW = new Date(2026, 8, 30, 10, 0);

const row = (id: string, over: Partial<ProjectRow> = {}): ProjectRow => ({
  id,
  key: `TSK-${id}`,
  name: `Task ${id}`,
  rank: { number: null, calc: 'not ranked: missing ease' },
  starred: false,
  client: null,
  assignee: null,
  due: null,
  completed: false,
  stage: null,
  status: 'Active',
  statusPosition: 2000,
  waitReason: null,
  category: null,
  awaitingDecision: false,
  estimate: null,
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
  ...over,
});

const hay = (one: ProjectRow): string => `${one.name} ${one.client ?? ''}`;

function proveClientsApart(first: string, second: string): void {
  const rows = [
    row('a1', { client: first }),
    row('a2', { client: first }),
    row('b1', { client: second }),
  ];
  const facets = projectFacets(rows, NOW);
  const clients = facets.filter((facet) => facet.kind === 'Client');
  const ids = clients.map((facet) => facet.id);
  expect.soft(ids, 'one facet id per client').toStrictEqual([...new Set(ids)]);
  for (const facet of clients) {
    const shown = narrowRows(rows, { ids: [facet.id], text: [] }, facets, hay).map(
      (each) => `${each.id} ${each.client ?? ''}`,
    );
    const own = rows
      .filter((each) => each.client === facet.label)
      .map((each) => `${each.id} ${each.client ?? ''}`);
    expect(shown, `narrowing on ${facet.label}`).toStrictEqual(own);
  }
}

describe('REVIEW-2C1-4 client facet ids collide when names slug alike', () => {
  it('REVIEW-2C1-4: "Smith & Co" and "Smith Co" get distinct facet ids and each narrows to its own rows', () => {
    proveClientsApart('Smith & Co', 'Smith Co');
  });

  it('REVIEW-2C1-4: non-Latin clients 日本 and 大阪 (both client:-) get distinct facet ids and each narrows to its own rows', () => {
    proveClientsApart('日本', '大阪');
  });
});
