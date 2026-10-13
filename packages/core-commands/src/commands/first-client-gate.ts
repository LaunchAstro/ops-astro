// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the gate before the first real client data and the first client invite.
//
// One fail-closed readiness check, read inside the refused command's own
// transaction by every command the catalogue classes `client-data` or
// `invitation` (from its effect metadata, never its name). A made-up-data
// installation runs them; a real-data installation refuses them while any of
// the eight items, the three closing lines or item 3's procedure line is
// open. The mode and the items live in `ops`, which the
// application's role reads through `public.first_client_readiness()` and
// writes only through the gate's own commands (`gate-write.ts`, migration
// 0059); the readiness value itself is derived, never written. The stop and
// removal controls (`STOP_CONTROLS`) are the one exception to the class: a shut
// gate never keeps a person from stopping work or erasing data.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { COMMAND_EFFECTS, classOf, type CommandName } from '../../../core-wire/src/index.ts';
import type { DataEffects } from '../../../core-wire/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

/**
 * The eight gate items, the three closing lines (0060) and item 3's
 * privacy-request procedure line (0071), as `ops.gate_items` names them. A
 * closing line carries the owner's one line; the procedure line, its link alone.
 */
export const GATE_ITEMS = [
  'tested-backups',
  'second-factor',
  'legal-basics',
  'privacy-act-statement',
  'overseas-register',
  'breach-runbook',
  'security-pass',
  'phone-alerts',
  'privacy-opt-in',
  'cloudflare-rolled',
  'training-line',
  'privacy-procedure',
] as const;

export type GateItem = (typeof GATE_ITEMS)[number];

/** The installation as `public.first_client_readiness()` reads it. */
export interface Readiness {
  readonly mode: string;
  readonly open_items: readonly string[];
}

/**
 * The commands that only stop work, withdraw authority or erase data. They
 * write client rows, so the catalogue classes them `client-data`, but they
 * bring no client data in, and a gate shut after go-live must not keep anyone
 * from cancelling a run, revoking an agent's delegation or mandate, writing off
 * a spend or trashing and purging a task.
 */
export const STOP_CONTROLS: ReadonlySet<CommandName> = new Set<CommandName>([
  'task.cancel',
  'delegation.revoke',
  'mandate.revoke',
  'run.end_at_budget_stop',
  'budget.write_off',
  'task.trash',
  'task.purge',
]);

const GATE_FIXES: readonly string[] = [
  'This installation holds real client data, so client records and client invitations wait until every item on the first-client gate is done.',
  'Ask the owner to record the open items named here, each with its evidence link, then try again.',
];

/**
 * What shuts a command with these effects: the open items, or none. A
 * made-up-safe command is never shut. Anything but a known mode shuts every
 * gated command, named `installation`: the check fails closed.
 */
export function gateDecision(effects: DataEffects, readiness: Readiness | null): string[] {
  if (classOf(effects) === 'made-up-safe') return [];
  if (readiness === null || (readiness.mode !== 'made-up' && readiness.mode !== 'real')) {
    return ['installation'];
  }
  return readiness.mode === 'real' ? [...readiness.open_items] : [];
}

/** The refusal for this command on this installation, read inside its transaction, or none. */
export async function firstClientGate(
  tx: TenantQuery,
  name: CommandName,
): Promise<CommandRefusal | undefined> {
  const effects = COMMAND_EFFECTS[name];
  if (classOf(effects) === 'made-up-safe' || STOP_CONTROLS.has(name)) return undefined;
  // A database from before 0058 has neither the function nor the table, and
  // 0058 provisions it made-up. Either one alone is not that: the call below
  // then fails, and the command with it.
  const [schema] = await tx.query<{ readonly before_gate: boolean }>(
    `select to_regprocedure('public.first_client_readiness()') is null
        and to_regclass('ops.installation') is null as before_gate`,
  );
  if (schema?.before_gate === true) return undefined;
  const [readiness] = await tx.query<Readiness>(
    'select mode, open_items from public.first_client_readiness()',
  );
  const open = gateDecision(effects, readiness ?? null);
  return open.length === 0 ? undefined : refuseCommand('GATE_SHUT', open, GATE_FIXES);
}
