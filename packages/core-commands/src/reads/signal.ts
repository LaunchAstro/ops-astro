// SPDX-License-Identifier: AGPL-3.0-only
//
// `connection.signal` (MP-14-8): grants, tripwires and the night round on
// Connections & signal, sections 006 to 008.
//
// Every list is filtered by the scopes the caller holds `connection:read` at,
// inside its statement (`listGrants`, `listTripwires`, `readNightRound`), and a
// caller holding the key nowhere is refused rather than shown empty sections.
// The counts are taken from the rows returned beside them, and the roster
// counts only the live grants the caller can see, so no number here reaches
// past the rows.

import {
  grantedScopes,
  listAgents,
  listGrants,
  listTripwires,
  readNightRound,
  subjectsOf,
  type GrantRow,
  type NightRound,
  type Session,
  type TenantQuery,
  type TripwireRow,
} from '../../../core-records/src/index.ts';
import type {
  ConnectionSignalResult,
  GrantView,
  TripwireView,
} from '../../../core-wire/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';
import type { ReadResult } from './requests.ts';

const grantView = (row: GrantRow): GrantView => ({
  id: row.id,
  agentId: row.agentId,
  purpose: row.purpose,
  collections: row.collections,
  access: row.actions.every((action) => action === 'read') ? 'read' : 'exec',
  client: row.clientId === null ? null : { id: row.clientId, label: row.clientLabel },
  grantedAt: row.grantedAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  endedAt: row.endedAt?.toISOString() ?? null,
  revocationCause: row.revocationCause,
  state: row.state,
  redemptions: row.redemptions,
});

const tripwireView = (row: TripwireRow): TripwireView => ({
  id: row.id,
  what: row.what,
  rule: row.rule,
  watching: row.watching,
  state: row.state,
  blockedReason: row.blockedReason,
  firedCount: row.firedCount,
  lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
  filedItem: row.filedItem,
  filedNothing: row.filedNothing,
  note: row.note,
});

function nightRoundView(round: NightRound | null): ConnectionSignalResult['nightRound'] {
  if (round === null) return null;
  return {
    roundOn: round.roundOn,
    steps: round.steps.map((step) => ({
      id: step.id,
      at: step.at.toISOString(),
      tone: step.tone,
      what: step.what,
      who: step.who,
      say: step.say,
      cite:
        step.citeKind === null
          ? null
          : { kind: step.citeKind, ref: step.citeRef, label: step.citeLabel ?? '' },
    })),
    notClean: round.steps.filter((step) => step.tone === 'bad').length,
  };
}

export async function readConnectionSignal(
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
  const leases = (await listGrants(tx, scopes)).map((row) => grantView(row));
  const tripwires = (await listTripwires(tx, scopes)).map((row) => tripwireView(row));
  const nightRound = nightRoundView(await readNightRound(tx, scopes));
  const agents = await listAgents(tx);
  const live = leases.filter((one) => one.state === 'live');
  return {
    ok: true,
    leases,
    leaseCounts: {
      live: live.length,
      ranOut: leases.filter((one) => one.state === 'ran_out').length,
      takenBack: leases.filter((one) => one.state === 'taken_back').length,
      liveExec: live.filter((one) => one.access === 'exec').length,
    },
    tripwires,
    tripwireCounts: {
      armed: tripwires.filter((one) => one.state === 'armed').length,
      cannotBeArmed: tripwires.filter((one) => one.state === 'cannot_be_armed').length,
    },
    nightRound,
    roster: agents.map((agent) => ({
      agentId: agent.id,
      active: agent.active,
      liveGrants: live.filter((one) => one.agentId === agent.id).length,
    })),
  };
}
