// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations whose value is visual, and where the command line hands off
// to them (AW-09; spike RN-10, research section 8).
//
// Parity is the rule: every operation the app performs has its command, and
// the command line reaches it through the registry. A few operations are not
// a request with an answer but a page someone looks at, and the command
// line's honest answer to one is the address of that page, not a copy of it.
// Each row here names such an operation, the app route that draws it, the one
// parameter the address needs, and why the JSON answer is not the same thing.
// The command line prints the link and sends nothing: the page asks for its
// own session and reads through its own commands, so a hand-off grants no
// authority and reads no data. `scripts/command-parity.mjs` fails when a row
// names a route the app does not register, or a name that is also a command.

export interface VisualHandoff {
  /** What the command line takes as its verb. Never a command's name. */
  readonly name: string;
  /** The app route's path, as `apps/web/src/routes.ts` registers it. */
  readonly route: string;
  /** The route's one parameter, given in the body under this name. */
  readonly param: string;
  /** Why the operation is visual, in a sentence the command line prints. */
  readonly why: string;
}

export const VISUAL_HANDOFFS: readonly VisualHandoff[] = [
  {
    name: 'review.view',
    route: '/task/:key',
    param: 'key',
    why:
      "The review round as its page draws it: the agent's output and its stored evidence beside " +
      'the version history, the rounds used and the decisions on offer. task.read answers the ' +
      'same facts as JSON; this page is where a reviewer sees them together.',
  },
];

/** The hand-off a verb names, or `undefined` for any other verb. */
export function handoffOf(verb: string): VisualHandoff | undefined {
  return VISUAL_HANDOFFS.find((one) => one.name === verb);
}

/** The page's address under the app's origin, the parameter encoded as one path segment. */
export function handoffAddress(handoff: VisualHandoff, origin: string, value: string): string {
  return `${origin.replace(/\/+$/u, '')}${handoff.route.replace(`:${handoff.param}`, encodeURIComponent(value))}`;
}
