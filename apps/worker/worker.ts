// SPDX-License-Identifier: AGPL-3.0-only
//
// The worker's composition root and its one job so far (T2b): propose one
// versioned synthetic change to the task its delegation is for.
//
// It is a client of the API and nothing more (spike RN-04). It talks through
// the command line's own agent entry (`apps/cli/client.ts`), holds an agent
// login and one delegation, and never opens the database: no module it loads
// can, which `tests/worker/worker-boundary.test.ts` checks on its import graph.
// Which task it works on is the delegation's answer, read from
// `session.capabilities`, never chosen here.

import { randomUUID } from 'node:crypto';
import { createCli, isRefusal, type CliAnswer, type Transport } from '../cli/client.ts';
import type { UsageReporter } from './usage.ts';

export interface WorkerOptions {
  readonly transport: Transport;
  readonly businessKey: string;
  /** The agent's own login bearer. */
  readonly credential: string;
  /** The one delegation it acts under, from `OPS_ASTRO_DELEGATION` as the command line takes it. */
  readonly delegation: string;
  readonly reporter: UsageReporter;
}

export const SYNTHETIC_STEP = { kind: 'synthetic_comment', payload: {} } as const;

export type WorkerOutcome =
  | {
      readonly proposed: {
        readonly taskId: string;
        readonly version: number;
        readonly gateId: string;
      };
    }
  | { readonly refused: { readonly code: string; readonly names: readonly string[] } }
  | { readonly fault: { readonly status: number } };

interface Answered {
  readonly body: Record<string, unknown>;
  readonly detail: Record<string, unknown>;
}

export function createWorker(options: WorkerOptions): {
  readonly proposeOnce: () => Promise<WorkerOutcome>;
} {
  const cli = createCli({
    entry: 'agent',
    businessKey: encodeURIComponent(options.businessKey),
    credential: options.credential,
    delegation: options.delegation,
    transport: options.transport,
  });
  // Every agent call carries an operation id, reads included (`agent-envelope.ts`).
  const call = async (verb: string, body: object): Promise<Answered | WorkerOutcome> =>
    settle(await cli.run(verb, { operationId: randomUUID(), ...body }));

  return {
    proposeOnce: async () => {
      const capabilities = await call('session.capabilities', {});
      if (!('body' in capabilities)) return capabilities;
      const scope = capabilities.body['purposeScope'] as { id?: unknown } | null | undefined;
      const recordId = String(scope?.id ?? '');
      const read = await call('task.read', { recordId });
      if (!('body' in read)) return read;
      const task = read.detail['task'] as { revision?: unknown } | undefined;
      const proposed = await call('task.propose', {
        recordId,
        expectedRevision: task?.revision,
        purpose: SYNTHETIC_STEP.kind,
        maximumMinor: options.reporter.estimate(SYNTHETIC_STEP),
        currency: 'AUD',
        payload: {
          change: 'a team-only comment; this demonstration changes nothing outside the app',
        },
        step: SYNTHETIC_STEP,
      });
      if (!('body' in proposed)) return proposed;
      return {
        proposed: {
          taskId: recordId,
          version: Number(proposed.detail['version']),
          gateId: String(proposed.detail['gateId']),
        },
      };
    },
  };
}

/** A success's body, or the outcome that ends this attempt. No credential is ever in either. */
function settle(answer: CliAnswer): Answered | WorkerOutcome {
  const body = answer.body as Record<string, unknown> | undefined;
  if (answer.status >= 200 && answer.status < 300 && body !== undefined) {
    return { body, detail: (body['detail'] as Record<string, unknown> | undefined) ?? {} };
  }
  if (isRefusal(answer)) {
    const refusal = body as { code: string; names?: readonly string[] };
    return { refused: { code: refusal.code, names: refusal.names ?? [] } };
  }
  return { fault: { status: answer.status } };
}
