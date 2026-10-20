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
//   8. maximumMinor      the priced maximum the reservation holds before dispatch; zero
//                        is unpriced, the only kind the conversation seam sends (#1508)
//   9. settlesAt         the highest of accepted, started, completed, landed it reaches
//  10. nothingHappened   the provider answers that are positive proof nothing happened,
//                        or `not_reconcilable`, which the broker refuses to dispatch
//  11. billed            a billed operation is never part of a bulk action
//  12. concurrency       the durable ceiling on calls in flight for one business
//
// One registered with eleven does not register: `registerModelOperation`
// answers which declarations are missing or malformed, and `catalogue` throws.
// A streamed operation adds two more, each a function where present: `fold`,
// the whole stream as the one body `answer` reads, and `pieces`, a reader of
// the stream as it comes that gives display text only.

import type { DataClass } from './data-class.ts';

/** The four facts of a call, in the order they happen. A step settles no higher than its operation declares. */
export const SETTLE_LEVELS = ['accepted', 'started', 'completed', 'landed'] as const;
export type SettleLevel = (typeof SETTLE_LEVELS)[number];

/** What an answer means once the adapter has read it. Text only: the broker never acts on it. */
/** A tool the model asked for, as the provider returned it. */
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ModelAnswer {
  readonly text: string;
  /** The tools the model asked for, in the provider's order (#1623 R3); absent, none. */
  readonly toolCalls?: readonly ModelToolCall[];
  /** The model the provider says answered, or null when it named none. */
  readonly model: string | null;
  readonly usage: { readonly inputUnits: number; readonly outputUnits: number };
  /** The provider's own code for an answer that did nothing (a refusal before any work). */
  readonly providerCode: string | null;
  /** What the provider says the answer cost, in its own currency; a price reads it, never estimates. */
  readonly reportedCost?: { readonly currency: string; readonly amount: number };
}

/** A model id as a provider may name one; 0098 holds the same shape. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

/**
 * The model an answer names: null when it names none, `undefined` when what it
 * names is out of shape, which makes the whole answer malformed.
 */
export function readModelId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && MODEL_ID.test(value) ? value : undefined;
}

/** The request an adapter builds. No origin, no credential: custody adds both. */
export interface AdapterRequest {
  readonly path: string;
  readonly method: 'POST' | 'PUT';
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
  /** A streamed answer's whole body as the text `answer` reads; undefined when it cannot be read. */
  readonly fold?: (body: string) => string | undefined;
  /** A reader of the stream as it arrives, giving display text only. */
  readonly pieces?: () => PieceReader;
  /** Takes a model turn (#1623 R3) in its one field, `turn`, instead of fields. */
  readonly turn?: true;
}

/** Display texts from a complete, in-order stream, as its chunks arrive. */
export interface PieceReader {
  push(chunk: Uint8Array | string): readonly string[];
}

/** The two a streamed operation adds; absent, its answer is read whole. */
const STREAMING = ['fold', 'pieces'] as const;

export type Declaration = Exclude<
  keyof ModelOperationDeclaration,
  (typeof STREAMING)[number] | 'turn'
>;

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
  | {
      readonly ok: false;
      readonly faults: readonly (Declaration | (typeof STREAMING)[number] | 'turn')[];
    };

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
  maximumMinor: (value) => value === 0 || positiveWhole(value, 100_000_000),
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
  const faults = [
    ...DECLARATIONS.filter(
      (name) => !Object.hasOwn(shape, name) || !WELL_FORMED[name](shape[name]),
    ),
    ...STREAMING.filter((name) => shape[name] !== undefined && typeof shape[name] !== 'function'),
    ...(shape['turn'] === undefined || shape['turn'] === true ? [] : (['turn'] as const)),
  ];
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
