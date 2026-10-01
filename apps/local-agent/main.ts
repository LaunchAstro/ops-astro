// SPDX-License-Identifier: AGPL-3.0-only
//
// The local runner process (LA-1, #859): `node apps/local-agent/main.ts`.
//
// It reads its settings from the environment (settings.ts), refuses to start
// anywhere but OPS_ENVIRONMENT=local, and prints the loopback origin the
// broker's `local-claude` destination points at. OPS_LOCAL_AGENT_PORT fixes
// the port; unset, the system picks one. It never prints a setting's value.

import { createRunner, type Runner } from './runner.ts';
import { readSettings } from './settings.ts';

export { createRunner } from './runner.ts';
export { readSettings } from './settings.ts';

export async function main(
  env: Readonly<Record<string, string | undefined>>,
  print: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<Runner | number> {
  const read = readSettings(env);
  if (!read.ok) {
    print(`${read.code}: ${read.message}`);
    return 1;
  }
  const port = Number(env['OPS_LOCAL_AGENT_PORT'] ?? '0');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    print('OPS_LOCAL_AGENT_PORT is a port number');
    return 2;
  }
  const runner = await createRunner(read.settings, undefined, port);
  print(`local-claude runner on ${runner.origin} (seat ${read.settings.seat})`);
  return runner;
}

if (import.meta.main) {
  const started = await main(process.env);
  if (typeof started === 'number') process.exit(started);
}
