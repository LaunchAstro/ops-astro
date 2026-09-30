// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-11: the Projects board's group banners, pure. The groups are the rows'
// statuses in the workflow's order, the position each row's state carries
// from the board's read (never the order the rows arrive in), and a banner's
// waiting reasons are the distinct reasons of its own rows, after the
// heading. Synthetic rows only.

import { describe, expect, it } from 'vitest';
import { groupReason, statusOrder, type ProjectRow } from '../../packages/ui/src/board/projects.ts';

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

describe("MP-5-11 groups in the status vocabulary's order (not first-seen)", () => {
  it('orders the statuses by the workflow’s positions, whatever order the rows arrive in', () => {
    const rows = [
      row('a', { status: 'Complete', statusPosition: 5000 }),
      row('b', { status: 'On hold', statusPosition: 4000 }),
      row('c', { status: 'Active', statusPosition: 2000 }),
      row('d', { status: 'Complete', statusPosition: 5000 }),
      row('e', { status: 'Needs review', statusPosition: 1000 }),
      row('f', { status: 'Waiting on client', statusPosition: 3000 }),
    ];
    expect(statusOrder(rows)).toStrictEqual([
      'Needs review',
      'Active',
      'Waiting on client',
      'On hold',
      'Complete',
    ]);
  });

  it('follows a reordered workflow: the positions decide, not the words', () => {
    const rows = [
      row('a', { status: 'Active', statusPosition: 2000 }),
      row('b', { status: 'Complete', statusPosition: 10 }),
    ];
    expect(statusOrder(rows)).toStrictEqual(['Complete', 'Active']);
  });

  it('puts a status with no position after every placed one, in the order first seen', () => {
    const rows = [
      row('a', { status: 'No state', statusPosition: null }),
      row('b', { status: 'Active', statusPosition: 2000 }),
      row('c', { status: 'Other', statusPosition: null }),
      row('d', { status: 'Needs review', statusPosition: 1000 }),
    ];
    expect(statusOrder(rows)).toStrictEqual(['Needs review', 'Active', 'No state', 'Other']);
  });

  it('draws no group for a status no row is in', () => {
    expect(statusOrder([row('a')])).toStrictEqual(['Active']);
    expect(statusOrder([])).toStrictEqual([]);
  });
});

describe('MP-5-11 waiting reasons after the heading', () => {
  it('names each distinct reason of the group’s rows once, in the order first seen', () => {
    const rows = [
      row('a', { waitReason: 'approval' }),
      row('b'),
      row('c', { waitReason: 'client reply' }),
      row('d', { waitReason: 'approval' }),
    ];
    expect(groupReason(rows)).toBe('approval · client reply');
  });

  it('says nothing for a group with no reason', () => {
    expect(groupReason([row('a'), row('b')])).toBeNull();
    expect(groupReason([])).toBeNull();
  });
});
