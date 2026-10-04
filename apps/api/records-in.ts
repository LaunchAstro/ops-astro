// SPDX-License-Identifier: AGPL-3.0-only
//
// How many records a read handed out, for the export-volume signal and the
// agent quota: a task is one, a list is its length, a frontier is its tickets
// and its fog, and a map is its tickets and its components.

import type { MapFrontierResult, MapViewResult } from '../../packages/core-wire/src/index.ts';

export function recordsIn(read: object): number {
  if ('frontier' in read) {
    const { frontier, fog } = read as MapFrontierResult;
    return frontier.length + fog.length;
  }
  const lists = ['tasks', 'persons', 'queue'].map((key) => (read as Record<string, unknown>)[key]);
  const listed = lists.find((list): list is readonly unknown[] => Array.isArray(list));
  if (listed !== undefined) return listed.length;
  if ('map' in read) {
    const { map } = read as MapViewResult;
    const parts = [map.destination, map.notes].filter((part) => part !== null).length;
    return map.tickets.length + map.fog.length + map.outOfScope.length + parts;
  }
  return 'task' in read || 'sharedTask' in read ? 1 : 0;
}
