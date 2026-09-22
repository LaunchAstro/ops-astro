// SPDX-License-Identifier: AGPL-3.0-only
//
// The three surfaces, each enumerated from its own real artefact.
//
// The rule: a surface's set is read from the thing that actually serves it,
// never from the table it was built out of. The **API** gives Hono's own route
// list after construction, so a route that failed to register is missing here
// even though its declaration is intact. The **CLI** and the **app** are asked
// through `accepts` and `offers`, the functions a shell argument and a screen
// really reach. All three are then compared against `exportedOperationSurface()`,
// which is read out of the dispatch and out of none of them.

import { exportedOperationSurface } from './exported.ts';
import type { CommandName } from '../commands/surface.ts';

export interface SurfaceReading {
  readonly surface: 'app' | 'api' | 'cli';
  readonly operations: ReadonlySet<string>;
}

export interface ParityFinding {
  readonly surface: SurfaceReading['surface'];
  /** Handled by the dispatch and absent from this surface. */
  readonly missing: readonly string[];
  /** Offered by this surface and handled by nothing. */
  readonly unhandled: readonly string[];
}

/** Every disagreement between a surface and the operations that really exist. */
export function findParityGaps(readings: readonly SurfaceReading[]): readonly ParityFinding[] {
  const exported = exportedOperationSurface();
  return readings
    .map((reading) => ({
      surface: reading.surface,
      missing: [...exported].filter((name) => !reading.operations.has(name)).toSorted(),
      unhandled: [...reading.operations]
        .filter((name) => !exported.has(name as CommandName))
        .toSorted(),
    }))
    .filter((finding) => finding.missing.length > 0 || finding.unhandled.length > 0);
}

/** Hono's registered POST routes, turned back into command names. */
export function operationsFromRoutes(
  routes: readonly { readonly method: string; readonly path: string }[],
): ReadonlySet<string> {
  return new Set(
    routes
      .filter((route) => route.method === 'POST')
      .map((route) => route.path.replace(/^\//u, '').replace('/', '.')),
  );
}

/** Ask a surface, one candidate at a time, what it will take. */
export function operationsAccepted(
  offers: (verb: string) => boolean,
  candidates: readonly string[],
): ReadonlySet<string> {
  return new Set(candidates.filter((candidate) => offers(candidate)));
}

/**
 * The operations whose value is visual, counted rather than asserted.
 *
 * Specification 17 asks the slice to **count** this class before parity is
 * called complete, because the command line's honest answer for such an
 * operation is a link to hand off to, and an uncounted class grows.
 *
 * It is one. `task.decide` is the only first-slice operation whose input a
 * person forms by looking at something — the rendered evidence pack — and even
 * there the decision is a data operation, which is why it stays on the command
 * line rather than being excused from it (17.1). `task.pickup` and
 * `task.handback` were considered and are not in the class: an agent forms both
 * from data it already holds. Parity is waived for nothing here; the test
 * beside it asserts every member is still offered on all three surfaces.
 */
export const VISUAL_VALUE_OPERATIONS: readonly string[] = ['task.decide'];
