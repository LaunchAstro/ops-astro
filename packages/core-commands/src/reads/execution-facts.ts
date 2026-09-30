// SPDX-License-Identifier: AGPL-3.0-only
//
// The run facts `execution.ts` reads for the graph (`execution-graph.ts`),
// checked before projection: a malformed fact throws, so the read answers
// unavailable, never an empty graph.

import { definitionOf, type RunDefinition } from './execution-definition.ts';
import { helpersOf, type HelperEntry } from './execution-helpers.ts';

/** What `execution.ts` reads for each run. */
export interface RunFacts {
  readonly runId: string;
  readonly lineageId: string;
  readonly state: string;
  /** The plan step its proposal named (0210), or null. */
  readonly planStepKey: string | null;
  readonly superseded: boolean;
  readonly gateState: string | null;
  readonly currency: string;
  readonly lease: {
    readonly state: string;
    readonly expiresAt: string;
    readonly lapsed: boolean;
    readonly holderActorId: string;
    readonly agent: boolean;
  } | null;
  readonly attempt: {
    readonly id: string;
    readonly state: string;
    readonly outcome: string | null;
  } | null;
  readonly effectObserved: boolean;
  readonly heldMinor: number | null;
  readonly spentMinor: number | null;
  readonly lastKind: string | null;
  readonly lastFault: string | null;
  /** AW-11's helpers, as `execution-helpers.ts` reads them. */
  readonly helpers: readonly HelperEntry[];
  /** AW-04's pin and read ledger, as `execution-definition.ts` reads them; null with no pin. */
  readonly definition: RunDefinition | null;
}

export function validateFacts(facts: unknown): readonly RunFacts[] {
  if (!Array.isArray(facts)) throw new Error('task.execution: the run facts are not a list');
  return facts.map((fact: unknown, index) => {
    const where = `task.execution: run fact ${String(index)}`;
    if (!isRecord(fact)) throw new Error(`${where} is not an object`);
    for (const key of ['runId', 'lineageId', 'state', 'currency'] as const) {
      if (typeof fact[key] !== 'string') throw new Error(`${where}: ${key} is not a string`);
    }
    for (const key of ['superseded', 'effectObserved'] as const) {
      if (typeof fact[key] !== 'boolean') throw new Error(`${where}: ${key} is not a boolean`);
    }
    for (const key of ['gateState', 'lastKind', 'lastFault', 'planStepKey'] as const) {
      if (fact[key] !== null && typeof fact[key] !== 'string')
        throw new Error(`${where}: ${key} is neither null nor a string`);
    }
    for (const key of ['heldMinor', 'spentMinor'] as const) {
      const value = fact[key];
      if (
        value !== null &&
        !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      )
        throw new Error(`${where}: ${key} is neither null nor a whole non-negative number`);
    }
    const { lease, attempt } = fact;
    if (
      lease !== null &&
      !(
        isRecord(lease) &&
        typeof lease['state'] === 'string' &&
        typeof lease['expiresAt'] === 'string' &&
        typeof lease['lapsed'] === 'boolean' &&
        typeof lease['holderActorId'] === 'string' &&
        typeof lease['agent'] === 'boolean'
      )
    )
      throw new Error(`${where}: the lease is malformed`);
    if (
      attempt !== null &&
      !(
        isRecord(attempt) &&
        typeof attempt['id'] === 'string' &&
        typeof attempt['state'] === 'string' &&
        (attempt['outcome'] === null || typeof attempt['outcome'] === 'string')
      )
    )
      throw new Error(`${where}: the attempt is malformed`);
    return {
      ...(fact as unknown as RunFacts),
      helpers: helpersOf(fact['helpers'], where),
      definition: definitionOf(fact['definition'], where),
    };
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
