// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal, sections 001 to 005 (MP-14-7a; ruling R51: the fleet
// first). One read, `connection.fleet`, draws the banner, the tiles, the
// facet counts and the table, so the counts and the rows cannot disagree.
//
// The marker says when the fleet last made a pass. It is an indicator only
// (`docs/design-system/research/LIVE-SYNC.md`): nothing on it acts. There is
// no "Run all syncs now" (removed from the mockup's AG-C3).
//
// Section 001 draws three of the mockup's five tiles (AG-C9), the three the
// fleet read derives. Open alerts waits on MP-14-8's tripwires and Clients
// fully wired has no derivation yet (the mockup types it, D-A7); the verdict
// strip (AG-C8, quota burn and credential runway) and the footnote naming
// "the five above" (AG-C10) come with them.
//
// Sections 003 to 005 (credentials and quota, data quality, band health) draw
// on data the phase 6 sources bring; until MP-14-7b they say so. Sections 006
// to 008 (grants, tripwires, the night round) are MP-14-8's, read apart on
// `connection.signal`; 009, skill costing, is MP-14-9's, read apart on
// `finance.skill_costs`. The per-client region from the scope bar down (010
// to 012) is MP-14-10a's, read apart on `connection.graduation`.
//
// The screen is keyed on the grant in `screen-registry.tsx`, so a change of
// business or person starts its view state and repair attempts over, and
// `useRead` drops an answer that belongs to an earlier grant. No topic reaches
// the fleet, so it re-reads on the rollup floor (LIVE-SYNC.md): every 30 s
// while the tab is visible, at once when shown again or back online; `keep`
// holds the drawn fleet and its view through each re-read.

import { useRef, useState, type ReactElement } from 'react';
import { Banner, Empty, InDevelopment, Kpi, SectionHead } from '@launchastro/ui';
import type {
  ConnectionFleetResult,
  ConnectionView,
} from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import type { RollupFloor } from '../data/rollup-floor.ts';
import { useRead } from '../data/use-read.ts';
import { useCommand } from '../records/use-command.ts';
import { RecordState } from '../views/record-state.tsx';
import { FleetTable } from './connections/fleet-table.tsx';
import { SignalSections } from './connections/signal.tsx';
import { SkillCostingSection } from './connections/costing.tsx';
import { GraduationRegion } from './connections/graduation.tsx';
import type { RepairControl } from './connections/fleet-row.tsx';
import { initialFleetView, withFacet, withOpen, type FleetView } from './connections/fleet-view.ts';

const FAILURE_WORDS: Readonly<Record<string, string>> = {
  auth_expired: 'its authorisation has expired',
  auth_revoked: 'its authorisation was revoked',
  quota_exhausted: 'its quota is used up',
  throttled: 'the source is throttling it',
  unreachable: 'the source cannot be reached',
  schema_changed: 'the source changed its data shape',
};

function lastPass(rows: readonly ConnectionView[]): string {
  const times = rows
    .map((row) => row.lastAttemptAt)
    .filter((at): at is string => at !== null)
    .map((at) => Date.parse(at));
  if (times.length === 0) return 'Last fleet pass: none yet';
  return `Last fleet pass ${new Date(Math.max(...times)).toLocaleTimeString()}`;
}

function Broken(props: {
  readonly broken: readonly ConnectionView[];
  readonly fix: () => void;
}): ReactElement | null {
  const count = props.broken.length;
  if (count === 0) return null;
  return (
    <div data-fleet-banner>
      <Banner
        tone="bad"
        lead={`${count === 1 ? '1 source is' : `${String(count)} sources are`} broken and accruing a data gap.`}
        action={
          <button
            type="button"
            className="btn btn--sm btn--primary"
            data-fleet-fix
            onClick={props.fix}
          >
            Fix now
          </button>
        }
      >
        {props.broken.map((row) => (
          <span key={row.id}>
            {row.label}: {FAILURE_WORDS[row.failureClass ?? ''] ?? 'it has stopped'}.{' '}
          </span>
        ))}
        Reports generated now will understate the affected clients.
      </Banner>
    </div>
  );
}

/** Clean, degraded and broken partition the fleet, so each is drawn out of it. */
function Tiles(props: { readonly fleet: ConnectionFleetResult }): ReactElement {
  const { counts } = props.fleet;
  const tile = (label: string, value: number): ReactElement => (
    <Kpi
      label={label}
      value={String(value)}
      of={String(counts.all)}
      track={{ value, max: counts.all }}
    />
  );
  return (
    <div className="statrow g3" data-fleet-tiles>
      {tile('Sources clean', counts.active)}
      {tile('Degraded', counts.degraded)}
      {tile('Broken', counts.broken)}
    </div>
  );
}

/**
 * Start a repair, then read the fleet again; what it came to is said on the
 * row. One attempt per repair asked for: a press whose answer was lost sends
 * the same `operationId` again, and a known answer ends the attempt.
 */
function useRepair(client: OperationsClient, reload: () => void): RepairControl {
  const command = useCommand();
  const attempts = useRef(new Map<string, string>());
  const [said, setSaid] = useState<Readonly<Record<string, string>>>({});
  const repair = (row: ConnectionView): void => {
    const intent = `${row.id}@${String(row.revision)}`;
    const operationId = attempts.current.get(intent) ?? client.newOperationId();
    attempts.current.set(intent, operationId);
    command.run(
      () =>
        client.mutate(
          'connector.repair',
          { connectionId: row.id },
          { operationId, expectedRevision: row.revision },
        ),
      (settlement) => {
        if (settlement.kind !== 'unknown') attempts.current.delete(intent);
        setSaid((before) => {
          const { [row.id]: _dropped, ...next } = before;
          return settlement.kind === 'ok' ? next : { ...next, [row.id]: settlement.because };
        });
        reload();
      },
    );
  };
  return { repair, locked: command.locked, said };
}

function NotConnected(): ReactElement {
  return (
    <>
      <section data-section="003" data-not-connected="credentials-quota">
        <SectionHead index="003" title="Credentials & quota" />
        <InDevelopment title="Token expiry and quota burn" owner="MP-14-7b" />
      </section>
      <section data-section="004" data-not-connected="data-quality">
        <SectionHead index="004" title="Data quality" right="What the numbers cannot tell you" />
        <InDevelopment title="Known gaps and restatement windows" owner="MP-14-7b" />
      </section>
      <section data-section="005" data-not-connected="band-health">
        <SectionHead index="005" title="Band health" />
        <InDevelopment title="Band health" owner="MP-14-7b" />
      </section>
    </>
  );
}

function Shown(props: {
  readonly fleet: ConnectionFleetResult;
  readonly now: number;
  readonly repair: RepairControl;
}): ReactElement {
  const { fleet } = props;
  const [view, setView] = useState<FleetView>(initialFleetView);
  const broken = fleet.connections.filter((row) => row.status === 'broken');
  // Fix now opens the repair flow for the sources the banner names: the
  // broken facet, with each of them open at its Repair button.
  const fix = (): void => {
    setView(
      withOpen(
        withFacet(view, 'broken'),
        broken.map((row) => row.id),
      ),
    );
  };
  return (
    <>
      <section data-section="001">
        <SectionHead
          index="001"
          title="Fleet state"
          right={`${String(fleet.counts.all)} sources · ${String(fleet.counts.clientConnections)} client connections`}
        />
        <Broken broken={broken} fix={fix} />
        <Tiles fleet={fleet} />
      </section>
      <section data-section="002">
        <SectionHead
          index="002"
          title="Connectors"
          right="Agency-wide · filter, sort and open a row for its clients"
        />
        <FleetTable
          rows={fleet.connections}
          counts={fleet.counts}
          view={view}
          setView={setView}
          now={props.now}
          repair={props.repair}
        />
      </section>
    </>
  );
}

export function ConnectionsScreen(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly now?: () => number;
  readonly rollup?: RollupFloor;
}): ReactElement {
  const { client, grantKey } = props;
  const clock = props.now ?? Date.now;
  const now = clock();
  const rollup = props.rollup === undefined ? {} : { rollup: props.rollup };
  const { state, reload } = useRead<ConnectionFleetResult>({
    grantKey,
    run: () => client.read<ConnectionFleetResult>('connection.fleet', {}),
    isEmpty: (value) => value.connections.length === 0,
    ...rollup,
    deps: [],
  });
  const repair = useRepair(client, reload);
  // A denied or unavailable read holds no fleet, so it draws no marker.
  const held = state.outcome === 'loading' ? state.previous : state.value;
  return (
    <div className="secs" data-screen="connections">
      {held === null ? null : (
        <p className="marker" data-fleet-marker>
          {lastPass(held.connections)}
        </p>
      )}
      <RecordState
        state={state}
        subject="fleet"
        onRetry={reload}
        keep
        empty={
          <Empty
            title="No connectors yet."
            description="Sources join the fleet as they are connected."
          />
        }
      >
        {(fleet) => <Shown fleet={fleet} now={now} repair={repair} />}
      </RecordState>
      <NotConnected />
      <SignalSections client={client} grantKey={grantKey} clock={clock} {...rollup} />
      <SkillCostingSection client={client} grantKey={grantKey} {...rollup} />
      <GraduationRegion client={client} grantKey={grantKey} {...rollup} />
    </div>
  );
}
