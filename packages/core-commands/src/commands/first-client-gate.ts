// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the gate before the first real client data and the first client invite.

import type { DataEffects } from '../../../core-wire/src/index.ts';

/** The eight gate items, as `ops.gate_items` names them. */
export const GATE_ITEMS = [
  'tested-backups',
  'second-factor',
  'legal-basics',
  'privacy-act-statement',
  'overseas-register',
  'breach-runbook',
  'security-pass',
  'phone-alerts',
] as const;

export type GateItem = (typeof GATE_ITEMS)[number];

/** The installation as `public.first_client_readiness()` reads it. */
export interface Readiness {
  readonly mode: string;
  readonly open_items: readonly string[];
}

/** What shuts a command with these effects: the open items, or none. */
export function gateDecision(_effects: DataEffects, _readiness: Readiness | null): string[] {
  throw new Error('S0-5: the readiness check is not built yet');
}
