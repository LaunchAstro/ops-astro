// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: what the wayfinder commands (WF-1, WF-2) do to data, a block of
// `COMMAND_EFFECTS` (data-effects.ts), which spreads it in.

import type { CommandName } from './surface.ts';
import { client, writing, type DataEffects } from './data-effects-types.ts';

type WayfinderCommand = Extract<
  CommandName,
  | 'task.set_type'
  | 'map.scope'
  | 'map.revise'
  | 'map.view'
  | 'map.frontier'
  | 'map.chart'
  | 'task.set_blocking'
  | 'task.claim'
  | 'map.graduate'
  | 'task.resolve'
  | 'task.close_out_of_scope'
>;

const READ = writing([]);
// A map or its ticket: the task, and the map's derived summary and frontier.
const MAP_TASK = writing(
  client('records', 'record_unique_values', 'map_summaries', 'map_frontier'),
);
// A write that can put a grilling or prototype ticket on its map's frontier,
// which raises the owner's decision item.
const MAP_RAISE = writing(MAP_TASK.writes.concat(client('inbox_items')));
// One numbered version: its components and the map's own version number.
const MAP_VERSION = writing(MAP_RAISE.writes.concat(client('map_components', 'map_versions')));

export const WAYFINDER_EFFECTS: { readonly [Name in WayfinderCommand]: DataEffects } = {
  // WF-1: a retype writes the task, and a grilling or prototype ticket newly on its
  // map's frontier raises the owner's decision item. A write to a map or its ticket refreshes the
  // map's summary and frontier (the records trigger, map_summary_on_record).
  'task.set_type': MAP_RAISE,
  // The map and every ticket under it carry the client.
  'map.scope': MAP_TASK,
  // One numbered version: its components and the map's own version number,
  // which refresh the map's summary and frontier as any write to the map does.
  'map.revise': writing(MAP_TASK.writes.concat(client('map_components', 'map_versions'))),
  'map.view': READ,
  'map.frontier': READ,
  // WF-2: a chart files the map, its tickets, their links and its first version.
  'map.chart': writing(MAP_VERSION.writes.concat(client('record_links'))),
  'task.set_blocking': writing(MAP_RAISE.writes.concat(client('record_links'))),
  'task.claim': MAP_TASK,
  'map.graduate': MAP_VERSION,
  'task.resolve': MAP_RAISE,
  'task.close_out_of_scope': MAP_VERSION,
};
