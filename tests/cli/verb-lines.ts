// SPDX-License-Identifier: AGPL-3.0-only
//
// The smallest valid line for each agent verb, for the tests that run every
// verb. `verb-preset-matrix-covers-every-verb` holds it to `VERB_TABLE`, so a
// new verb fails there until it has a line here.

export const SMALLEST_LINE: Readonly<Record<string, readonly string[]>> = {
  'task get': ['task', 'get', 'T-1'],
  'task list': ['task', 'list'],
  'task create': ['task', 'create', '--title', 'Synthetic task'],
  'task update': ['task', 'update', 'T-1', '--revision', '1'],
  'task comment': ['task', 'comment', 'T-1', '--revision', '1', '--text', 'Synthetic note'],
  'map view': ['map', 'view', 'M-1'],
  'map frontier': ['map', 'frontier', 'M-1'],
  'map list': ['map', 'list'],
};

/** Does any of `texts` hold `secret`? Asked as a yes or no, so a failure never prints it. */
export const holds = (secret: string, ...texts: readonly string[]): boolean =>
  texts.some((one) => one.includes(secret));
