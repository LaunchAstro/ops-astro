// SPDX-License-Identifier: AGPL-3.0-only
//
// How many records a read handed out, for the export-volume signal and the
// agent quota: a task is one, a list (a frontier included) is its length, and
// a map is its tickets and its components.

import type { MapViewResult } from '../../packages/core-wire/src/index.ts';

export function recordsIn(read: object): number {
  const lists = ['tasks', 'persons', 'queue', 'frontier'].map(
    (key) => (read as Record<string, unknown>)[key],
  );
  const listed = lists.find((list): list is readonly unknown[] => Array.isArray(list));
  if (listed !== undefined) return listed.length;
  if ('map' in read) {
    const { map } = read as MapViewResult;
    const parts = [map.destination, map.notes].filter((part) => part !== null).length;
    return map.tickets.length + map.fog.length + map.outOfScope.length + parts;
  }
  return 'task' in read || 'sharedTask' in read ? 1 : 0;
}
