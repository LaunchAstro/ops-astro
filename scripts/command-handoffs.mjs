// SPDX-License-Identifier: AGPL-3.0-only
// The visual hand-off check, moved whole from command-parity.mjs to keep that file under
// the line limit; command-parity.mjs runs it and re-exports it.

import { COMMAND_SURFACE, VISUAL_HANDOFFS } from '../packages/core-wire/src/index.ts';
import { ROUTES } from '../apps/web/src/routes.ts';

/**
 * AW-09: a visual hand-off is honest only if the app draws the page it names
 * and nothing with its name runs as a command: a route the app does not
 * register is a link to nowhere, and a shared name hides a command's verb.
 */
export function handoffFailures(
  handoffs = VISUAL_HANDOFFS,
  paths = Object.values(ROUTES).map((route) => route.path),
  commands = COMMAND_SURFACE.map((one) => one.name),
) {
  return handoffs.flatMap((one) => [
    ...(paths.includes(one.route) && one.route.includes(`:${one.param}`)
      ? []
      : [`the hand-off ${one.name} opens ${one.route}, which the app does not draw`]),
    ...(commands.includes(one.name) ? [`the hand-off ${one.name} is also a command's name`] : []),
  ]);
}
