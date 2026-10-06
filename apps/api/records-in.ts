// SPDX-License-Identifier: AGPL-3.0-only
//
// How many records a read handed out, for the export-volume signal and the
// agent quota: a task is one at any detail level, a list (a search's hits,
// the fleet and a page of the board too) is its length, a frontier is its
// tickets and its fog, a map is its tickets and its components, and the
// signal sections are their grants, tripwires, night round steps and roster.

import type {
  ConnectionSignalResult,
  MapFrontierResult,
  MapViewResult,
} from '../../packages/core-wire/src/index.ts';

export function recordsIn(read: object): number {
  if ('tripwires' in read) {
    const { grants, tripwires, nightRound, roster } = read as ConnectionSignalResult;
    return grants.length + tripwires.length + (nightRound?.steps.length ?? 0) + roster.length;
  }
  if ('frontier' in read) {
    const { frontier, fog } = read as MapFrontierResult;
    return frontier.length + fog.length;
  }
  const lists = ['tasks', 'persons', 'queue', 'hits', 'connections', 'page'].map(
    (key) => (read as Record<string, unknown>)[key],
  );
  const listed = lists.find((list): list is readonly unknown[] => Array.isArray(list));
  if (listed !== undefined) return listed.length;
  if ('map' in read) {
    const { map } = read as MapViewResult;
    const parts = [map.destination, map.notes].filter((part) => part !== null).length;
    return map.tickets.length + map.fog.length + map.outOfScope.length + parts;
  }
  const leveled = 'detail' in read && 'view' in read;
  return 'task' in read || 'sharedTask' in read || leveled ? 1 : 0;
}
