// SPDX-License-Identifier: AGPL-3.0-only
//
// The API scan's OpenAPI document, the command (S0-5 item 7; decisions in
// api-definition.ts). With --only, a target at any other origin is refused.
//
//   node scripts/security/api-definition.mjs --target <origin> --business <key>
//        --out <file> [--only <origin>]
//
// Exit 0 when written, 1 when refused, 2 on a usage mistake.

import { writeFileSync } from 'node:fs';
import { apiDefinition, DefinitionRefused, onlyTarget } from './api-definition.ts';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const [target, business, out] = [flag('target'), flag('business'), flag('out')];
if (target === undefined || business === undefined || out === undefined) {
  console.error('api-definition: name --target, --business and --out');
  process.exit(2);
}
try {
  const only = flag('only');
  if (only !== undefined) onlyTarget(target, only);
  const doc = apiDefinition(target, business);
  writeFileSync(out, `${JSON.stringify(doc, undefined, 2)}\n`);
  console.log(`api-definition: ${String(Object.keys(doc.paths).length)} routes written`);
} catch (error) {
  if (!(error instanceof DefinitionRefused)) throw error;
  console.error(`api-definition: ${error.message}`);
  process.exit(1);
}
