// SPDX-License-Identifier: AGPL-3.0-only
//
// The wayfinder commands' handlers (WF-1, WF-2), a block of `HANDLERS`
// (handlers.ts), which spreads it in (moved whole to keep it under its line cap).

import type { Handler, WriteName } from './handlers.ts';
import { scopeMap, setTaskType } from './wayfinder.ts';
import { reviseMap } from './wayfinder-revision.ts';
import { chartMap } from './wayfinder-chart.ts';
import { claimTicket, graduateFog, setBlocking } from './wayfinder-blocking.ts';
import { closeOutOfScope, resolveTicket } from './wayfinder-resolve.ts';

type WayfinderName = Extract<
  WriteName,
  | 'task.set_type'
  | 'map.revise'
  | 'map.scope'
  | 'map.chart'
  | 'task.set_blocking'
  | 'task.claim'
  | 'map.graduate'
  | 'task.resolve'
  | 'task.close_out_of_scope'
>;

export const WAYFINDER_HANDLERS: { readonly [K in WayfinderName]: Handler<K> } = {
  'task.set_type': setTaskType,
  'map.revise': reviseMap,
  'map.scope': scopeMap,
  'map.chart': chartMap,
  'task.set_blocking': setBlocking,
  'task.claim': (tx, context) => claimTicket(tx, context),
  'map.graduate': graduateFog,
  'task.resolve': resolveTicket,
  'task.close_out_of_scope': closeOutOfScope,
};
