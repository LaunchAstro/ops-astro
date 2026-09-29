// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 skeleton for the red run: signatures only, built in the next commit.

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

export type ModelOperation = Readonly<ModelOperationDeclaration> & { readonly registered: true };

export type Registration =
  | { readonly ok: true; readonly operation: ModelOperation }
  | { readonly ok: false; readonly faults: readonly Declaration[] };

export function registerModelOperation(_declared: unknown): Registration {
  throw new Error('AW-01: not built');
}

export function catalogue(
  _declared: readonly ModelOperationDeclaration[],
): ReadonlyMap<string, ModelOperation> {
  throw new Error('AW-01: not built');
}
