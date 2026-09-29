// SPDX-License-Identifier: AGPL-3.0-only
//
// `connection.graduation` (MP-14-10a): the per-client region of Connections &
// signal. Every client the caller's `connection:read` scopes reach comes back
// at once, with its graduation rows, its not-revoked mandates and the scope
// list a new mandate picks from, so the scope bar is view state and asks the
// server nothing.
//
// Both lists are filtered by those scopes inside their statements
// (`listGraduation`); a caller holding the key nowhere is refused rather than
// shown an empty region. Each row's state is derived by `deriveGraduation`,
// the one rule the promote check and core's effect check also read.

import {
  deriveGraduation,
  grantedScopes,
  listGraduation,
  scopeChoices,
  subjectsOf,
  type Derived,
  type GraduationClassRow,
  type MandateRow,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type {
  ConnectionGraduationResult,
  GraduationRowView,
  MandateView,
} from '../../../core-wire/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';
import type { ReadResult } from './requests.ts';

const rowView = (row: GraduationClassRow, derived: Derived): GraduationRowView => ({
  id: row.id,
  clientId: row.clientId,
  actionClass: row.actionClass,
  classLabel: row.classLabel,
  clearance: row.clearance,
  state: derived.state,
  heldBy: derived.heldBy,
  neverWhy: row.neverWhy,
  promotedAt: derived.promotedBy?.createdAt.toISOString() ?? null,
  approved: row.approved,
  edited: row.edited,
  rejected: row.rejected,
  since: row.since,
  note: row.note,
  revision: row.revision,
});

const mandateView = (one: MandateRow, now: Date): MandateView => ({
  id: one.id,
  clientId: one.clientId,
  classes: one.classes,
  refuses: one.refuses,
  ceiling:
    one.ceilingMinor === null || one.currency === null
      ? null
      : { amountMinor: one.ceilingMinor, currency: one.currency },
  expiresAt: one.expiresAt.toISOString(),
  expired: one.expiresAt.getTime() <= now.getTime(),
  label: one.label,
  graduationClass: one.graduationClass,
  authoredBy: one.authoredBy,
  createdAt: one.createdAt.toISOString(),
  revision: one.revision,
});

/** The clients the rows name, in row order, each with its scope list. */
function clientsOf(classes: readonly GraduationClassRow[]): ConnectionGraduationResult['clients'] {
  const clients = new Map<string, { readonly label: string; readonly own: string[] }>();
  for (const row of classes) {
    const client = clients.get(row.clientId) ?? { label: row.clientLabel, own: [] };
    client.own.push(row.actionClass);
    clients.set(row.clientId, client);
  }
  return [...clients].map(([id, client]) => ({
    id,
    label: client.label,
    scopes: scopeChoices(client.own),
  }));
}

export async function readConnectionGraduation(
  tx: TenantQuery,
  session: Session,
): Promise<ReadResult | CommandRefusal> {
  const scopes = await grantedScopes(tx, subjectsOf(session), 'connection', 'read');
  if (scopes.length === 0) {
    return refuseCommand(
      'SCOPE_NOT_GRANTED',
      ['connection:read'],
      ['no live grant covers it', 'ask a holder who may delegate'],
    );
  }
  const { classes, mandates } = await listGraduation(tx, scopes);
  const now = new Date();
  const result: ConnectionGraduationResult = {
    ok: true,
    clients: clientsOf(classes),
    rows: classes.map((row) => rowView(row, deriveGraduation(row, mandates, now))),
    mandates: mandates.map((one) => mandateView(one, now)),
  };
  return result;
}
