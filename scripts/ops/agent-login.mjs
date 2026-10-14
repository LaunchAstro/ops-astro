// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's sign-in, the command. The decisions are in `agent-login.ts`; this
// file runs them.
//
//   <custody> | node scripts/ops/agent-login.mjs make --agent <actor id> \
//     --email <address> [--production]
//
// A person's act under operations:manage, with OPS_ASTRO_TOKEN,
// OPS_ASTRO_BUSINESS (the business acted on), OPS_ASTRO_DEPLOYMENTS,
// DATABASE_ADMIN_URL and DATABASE_URL (TLS required), GOTRUE_URL,
// SUPABASE_SERVICE_KEY, STAGING_PROJECT_REF and PRODUCTION_PROJECT_REF set,
// every address on the one project the run is for. The agent's password
// arrives on standard input from custody, created there once and read back,
// never typed, never an argument, a setting or a file. Exit 0 when done, 1
// when refused or stopped; a rerun resumes a stopped act. Nothing printed
// carries a password, a key, a bearer or an address.

import { runAgentLogin } from './agent-login.ts';

const readPassword = async () => {
  // A terminal would echo it: the password comes from custody alone.
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/u, '');
};

const { status, lines } = await runAgentLogin(process.env, process.argv.slice(2), readPassword);
for (const line of lines) {
  if (status === 0) console.log(line);
  else console.error(line);
}
process.exitCode = status;
