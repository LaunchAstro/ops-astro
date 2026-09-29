// SPDX-License-Identifier: AGPL-3.0-only
//
// A model operation and its twelve declarations (AW-01).
//
// An operation is registered in code and reviewed, never by a command. The
// broker dispatches only an operation found in the catalogue, so a caller
// names an operation and never a destination, a template or a price. Each
// declaration below is one line of what the reviewer reads before it ships:
//
//   1. key               the catalogued name the broker dispatches by
//   2. provider          the adapter that builds the request and reads the answer
//   3. destination       the key of the one destination custody may send it to
//   4. fields            every prompt field and its data class
//   5. answer            the schema every answer is validated against
//   6. timeoutMs         how long custody waits for the answer
//   7. maxResponseBytes  how much of the answer custody reads
//   8. maximumMinor      the priced maximum the reservation holds before dispatch
//   9. settlesAt         the highest of accepted, started, completed, landed it reaches
//  10. nothingHappened   the provider answers that are positive proof nothing happened,
//                        or `not_reconcilable`, which the broker refuses to dispatch
//  11. billed            a billed operation is never part of a bulk action
//  12. concurrency       the durable ceiling on calls in flight for one business
//
// One registered with eleven does not register: `registerModelOperation`
// answers which declarations are missing or malformed, and `catalogue` throws.

import type { DataClass } from './data-class.ts';

/** The four facts of a call, in the order they happen. A step settles no higher than its operation declares. */
export const SETTLE_LEVELS = ['accepted', 'started', 'completed', 'landed'] as const;
export type SettleLevel = (typeof SETTLE_LEVELS)[number];

/** What an answer means once the adapter has read it. Text only: the broker never acts on it. */
export interface ModelAnswer {
  readonly text: string;
  readonly usage: { readonly inputUnits: number; readonly outputUnits: number };
  /** The provider's own code for an answer that did nothing (a refusal before any work). */
  readonly providerCode: string | null;
}

/** The request an adapter builds. No origin, no credential: custody adds both. */
export interface AdapterRequest {
  readonly path: string;
  readonly method: 'POST';
  readonly body: string;
}

export interface ModelOperationDeclaration {
  readonly key: string;
  readonly provider: string;
  readonly destination: string;
  readonly fields: Readonly<Record<string, DataClass>>;
  readonly answer: (body: unknown) => ModelAnswer | undefined;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maximumMinor: number;
  readonly settlesAt: SettleLevel;
  readonly nothingHappened: readonly string[] | 'not_reconcilable';
  readonly billed: boolean;
  readonly concurrency: number;
}

export type Declaration = keyof ModelOperationDeclaration;

/** In the order a reviewer reads them, and the order a refusal names them. */
export const DECLARATIONS: readonly Declaration[] = [
  'key',
  'provider',
  'destination',
  'fields',
  'answer',
  'timeoutMs',
  'maxResponseBytes',
  'maximumMinor',
  'settlesAt',
  'nothingHappened',
  'billed',
  'concurrency',
];

/** A registered operation: every declaration present and well formed, and frozen. */
export type ModelOperation = Readonly<ModelOperationDeclaration> & { readonly registered: true };

export type Registration =
  | { readonly ok: true; readonly operation: ModelOperation }
  | { readonly ok: false; readonly faults: readonly Declaration[] };

const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;
const DATA_CLASSES: ReadonlySet<string> = new Set([
  'business_internal',
  'client_scoped',
  'free_text',
  'personal',
]);

const positiveWhole = (value: unknown, most: number): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= most;

const WELL_FORMED: Readonly<Record<Declaration, (value: unknown) => boolean>> = {
  key: (value) => typeof value === 'string' && NAME.test(value),
  provider: (value) => typeof value === 'string' && /^[a-z][a-z0-9_]*$/u.test(value),
  destination: (value) => typeof value === 'string' && /^[a-z][a-z0-9_]*$/u.test(value),
  fields: (value) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every((kind) => typeof kind === 'string' && DATA_CLASSES.has(kind)),
  answer: (value) => typeof value === 'function',
  timeoutMs: (value) => positiveWhole(value, 120_000),
  maxResponseBytes: (value) => positiveWhole(value, 4 * 1024 * 1024),
  maximumMinor: (value) => positiveWhole(value, 100_000_000),
  settlesAt: (value) =>
    typeof value === 'string' && (SETTLE_LEVELS as readonly string[]).includes(value),
  nothingHappened: (value) =>
    value === 'not_reconcilable' ||
    (Array.isArray(value) && value.every((code) => typeof code === 'string' && code !== '')),
  billed: (value) => typeof value === 'boolean',
  concurrency: (value) => positiveWhole(value, 64),
};

/** Every declaration present and well formed, or the list of those that are not. */
export function registerModelOperation(declared: unknown): Registration {
  const shape = (typeof declared === 'object' && declared !== null ? declared : {}) as Record<
    string,
    unknown
  >;
  const faults = DECLARATIONS.filter(
    (name) => !Object.hasOwn(shape, name) || !WELL_FORMED[name](shape[name]),
  );
  if (faults.length > 0) return { ok: false, faults };
  const operation = Object.freeze({
    ...(shape as unknown as ModelOperationDeclaration),
    fields: Object.freeze({ ...(shape['fields'] as Record<string, DataClass>) }),
    registered: true as const,
  });
  return { ok: true, operation };
}

/** The reviewed catalogue: every entry registers, and no key twice, or the build fails. */
export function catalogue(
  declared: readonly ModelOperationDeclaration[],
): ReadonlyMap<string, ModelOperation> {
  const entries = new Map<string, ModelOperation>();
  for (const declaration of declared) {
    const registration = registerModelOperation(declaration);
    if (!registration.ok) {
      throw new Error(
        `model operation ${String(declaration.key)} does not register: ${registration.faults.join(', ')}`,
      );
    }
    if (entries.has(registration.operation.key)) {
      throw new Error(`model operation ${registration.operation.key} is registered twice`);
    }
    entries.set(registration.operation.key, registration.operation);
  }
  return entries;
}
