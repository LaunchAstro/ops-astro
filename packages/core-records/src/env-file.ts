// SPDX-License-Identifier: AGPL-3.0-only
//
// The one reader of a `KEY=value` file: the local slice's `.local/*.env` files
// and a delegation key file. Node's own dotenv parser does the parsing, so the
// server, the credential keys, the seed, the start scripts and the browser
// harness all read a file the same way.

import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * The settings in `file`. Comments, blanks and surrounding space are dropped.
 *
 * A file that cannot be read is empty, because a local file that has not been
 * written yet is not a fault. `required` makes it one: the read's own error is
 * thrown, for a file whose absence has to be looked at.
 */
export function readEnvFile(
  file: string,
  options: { readonly required?: boolean } = {},
): Readonly<Record<string, string | undefined>> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    if (options.required === true) throw cause;
    return {};
  }
  return { ...parseEnv(text) };
}
