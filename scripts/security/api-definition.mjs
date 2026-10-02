// SPDX-License-Identifier: AGPL-3.0-only
//
// The API scan's OpenAPI document, the command (ticket S0-5 item 7). The
// decisions are in `api-definition.ts`; this file writes them.
//
//   node scripts/security/api-definition.mjs --target <origin> --business <key> --out <file>
//
// Exit 0 when written, 1 when refused, 2 on a usage mistake.

import { writeFileSync } from 'node:fs';
import { apiDefinition, DefinitionRefused } from './api-definition.ts';

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
  const doc = apiDefinition(target, business);
  writeFileSync(out, `${JSON.stringify(doc, undefined, 2)}\n`);
  console.log(`api-definition: ${String(Object.keys(doc.paths).length)} routes written`);
} catch (error) {
  if (!(error instanceof DefinitionRefused)) throw error;
  console.error(`api-definition: ${error.message}`);
  process.exit(1);
}
