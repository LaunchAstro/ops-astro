// SPDX-License-Identifier: AGPL-3.0-only
//
// The smallest valid line for each agent verb, for the tests that run every
// verb. `verb-preset-matrix-covers-every-verb` holds it to `VERB_TABLE`, so a
// new verb fails there until it has a line here.

import { fileURLToPath } from 'node:url';

/** An empty JSON object for the verbs that read their body from a file. */
const BODY = fileURLToPath(new URL('fixtures/verb-body.json', import.meta.url));

export const SMALLEST_LINE: Readonly<Record<string, readonly string[]>> = {
  'task get': ['task', 'get', 'T-1'],
  'task list': ['task', 'list'],
  'task create': ['task', 'create', '--title', 'Synthetic task'],
  'task update': ['task', 'update', 'T-1', '--revision', '1'],
  'task comment': ['task', 'comment', 'T-1', '--revision', '1', '--text', 'Synthetic note'],
  'map view': ['map', 'view', 'M-1'],
  'map frontier': ['map', 'frontier', 'M-1'],
  'map list': ['map', 'list'],
  'task block': ['task', 'block', 'T-1', '--revision', '1', '--blocked-by', 'T-2'],
  'task claim': ['task', 'claim', 'T-1', '--revision', '1'],
  'task resolve': ['task', 'resolve', 'T-1', '--revision', '1', '--answer', 'A', '--gist', 'G'],
  'task close': ['task', 'close', 'T-1', '--revision', '1', '--reason', 'Synthetic reason'],
  'map chart': ['map', 'chart', '--body-file', BODY],
  'map graduate': [
    'map',
    'graduate',
    'M-1',
    '--revision',
    '1',
    '--patch',
    'P-1',
    '--body-file',
    BODY,
  ],
};

/** Does any of `texts` hold `secret`? Asked as a yes or no, so a failure never prints it. */
export const holds = (secret: string, ...texts: readonly string[]): boolean =>
  texts.some((one) => one.includes(secret));
