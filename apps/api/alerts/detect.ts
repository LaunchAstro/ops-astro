// SPDX-License-Identifier: AGPL-3.0-only
//
// The security detections (ticket S0-2, TR-SEC-9): repeated failed sign-ins,
// a permission, grant or custody change, a failed secret scan, a burst of
// cross-scope refusals, repeated webhook signature failures and unusual
// export or download volume.
//
// Each signal is counted under its own scope: the business and the person for
// sign-ins and refusals, the business and the source for webhooks, the
// business and the client for exports. One business's refusals never bring
// another's alert closer, and one client's exports never add to another's.
// The scope is a key in memory and nothing else: the alert raised is only its
// kind, so it cannot name the business, client or person that tripped it.
// The detector holds no connection and reads no row.

import type { AlertKind } from './catalogue.ts';

export type SecuritySignal =
  | { readonly kind: 'sign-in-failed'; readonly business: string; readonly person: string }
  | { readonly kind: 'authority-changed'; readonly business: string }
  | { readonly kind: 'secret-scan-failed' }
  | { readonly kind: 'cross-scope-refusal'; readonly business: string; readonly person: string }
  | {
      readonly kind: 'webhook-signature-failed';
      readonly business: string;
      readonly source: string;
    }
  | {
      readonly kind: 'export';
      readonly business: string;
      readonly client: string;
      readonly items: number;
    };

/** One API answer, as `apps/api/app.ts` reads it off the request. */
export interface Outcome {
  /** The business key from the path; the person is the verified subject, or empty. */
  readonly business: string;
  readonly person: string;
  /** The refusal code, or undefined when the command was carried out. */
  readonly refusal: string | undefined;
  readonly command: string;
}

export function signalOf(_outcome: Outcome): SecuritySignal | undefined {
  throw new Error('S0-2: not built');
}

export interface Detector {
  readonly observe: (signal: SecuritySignal) => void;
  /** How many scopes are held: bounded, whatever a caller sends. */
  readonly tracked: () => number;
}

export function createDetector(
  _raise: (kind: AlertKind) => void,
  _options: { readonly now?: () => number } = {},
): Detector {
  throw new Error('S0-2: not built');
}
