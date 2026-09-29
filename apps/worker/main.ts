// SPDX-License-Identifier: AGPL-3.0-only
//
// The worker process: `pnpm worker [--once]`.
//
// Configuration comes from the environment the command line reads
// (`apps/cli/main.ts`): the API's address, the business key, the agent's own
// login bearer and the one delegation it acts under. Nothing here reads a
// database address, and nothing prints a credential. Without `--once` it polls
// the API until its one proposal is made, then until a person's approval lets it
// apply that proposal once (T2c2), then exits; `--once` tries once.

import { httpTransport } from '../cli/client.ts';
import { SYNTHETIC_USAGE } from './usage.ts';
import { createWorker } from './worker.ts';

const EXIT = { ok: 0, refused: 1, usage: 2, fault: 4 } as const;
const REQUIRED = ['OPS_ASTRO_BUSINESS', 'OPS_ASTRO_TOKEN', 'OPS_ASTRO_DELEGATION'] as const;

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const missing = REQUIRED.filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0) {
    process.stderr.write(`worker: set ${missing.join(', ')}\n`);
    return EXIT.usage;
  }
  const api = (env['OPS_ASTRO_API_URL'] ?? 'http://127.0.0.1:8790').replace(/\/$/u, '');
  const worker = createWorker({
    transport: httpTransport(api),
    businessKey: env['OPS_ASTRO_BUSINESS'] as string,
    credential: env['OPS_ASTRO_TOKEN'] as string,
    delegation: env['OPS_ASTRO_DELEGATION'] as string,
    reporter: SYNTHETIC_USAGE,
  });
  const interval = Number(env['OPS_ASTRO_WORKER_INTERVAL_MS'] ?? 5_000);
  let proposedOn: string | undefined;
  for (;;) {
    let outcome: Awaited<ReturnType<typeof worker.proposeOnce>> | undefined;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one poll at a time, by design
      outcome = await (proposedOn === undefined
        ? worker.proposeOnce()
        : worker.applyOnce(proposedOn));
    } catch {
      // The failure's own text is never printed: a transport error can carry
      // the request, and the request carries both credentials (T2 canary token).
      process.stderr.write(`worker: no answer from ${api}\n`);
    }
    if (outcome !== undefined) process.stdout.write(`${JSON.stringify(outcome)}\n`);
    if (outcome !== undefined && 'proposed' in outcome) proposedOn = outcome.proposed.taskId;
    const settled = outcome !== undefined && 'applied' in outcome;
    if (argv.includes('--once') || settled) {
      if (outcome === undefined) return EXIT.fault;
      const ended = ['proposed', 'applied', 'idle', 'dropped'].some((key) => key in outcome);
      if (ended) return EXIT.ok;
      return 'refused' in outcome ? EXIT.refused : EXIT.fault;
    }
    // oxlint-disable-next-line no-await-in-loop -- the poll interval
    await new Promise<void>((done) => {
      setTimeout(done, interval);
    });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
