// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal, sections 001 to 005 (MP-14-7a; ruling R51: the fleet
// first). One read, `connection.fleet`, draws the banner, the tiles, the
// facet counts and the table, so the counts and the rows cannot disagree.
//
// The header marker says when the fleet last made a pass. It is an indicator
// only (`docs/design-system/research/LIVE-SYNC.md`): nothing on it acts. There
// is no "Run all syncs now" (removed from the mockup's AG-C3).
//
// Sections 003 to 005 (credentials and quota, data quality, band health) draw
// on data the phase 6 sources bring; until MP-14-7b they say so. Sections 006
// to 008 (grants, tripwires, the night round) are MP-14-8's, read apart; 009,
// skill costing, is MP-14-9's; and the per-client region from the scope bar
// down (010 to 012; R61, numbers read top to bottom) is MP-14-10a's.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Empty, InDevelopment } from '@launchastro/ui';
import type {
  ConnectionFleetResult,
  ConnectionView,
} from '../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../operations/client.ts';
import { FleetTable } from './connections/fleet-table.tsx';
import { SignalSections } from './connections/signal.tsx';
import { SkillCostingSection } from './connections/costing.tsx';
import { GraduationRegion } from './connections/graduation.tsx';
import {
  initialFleetView,
  toggleOpen,
  withFacet,
  type FleetView,
} from './connections/fleet-view.ts';

type Fleet =
  | { readonly state: 'loading' }
  | { readonly state: 'shown'; readonly fleet: ConnectionFleetResult }
  | { readonly state: 'refused'; readonly because: string }
  | { readonly state: 'unavailable'; readonly because: string };

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

function Banner(props: {
  readonly broken: readonly ConnectionView[];
  readonly fix: () => void;
}): ReactElement | null {
  if (props.broken.length === 0) return null;
  const count = props.broken.length;
  return (
    <div className="banner banner--bad" role="alert" data-fleet-banner>
      <p>
        <strong>
          {count === 1 ? '1 source is' : `${count} sources are`} broken and accruing a data gap.
        </strong>
      </p>
      <ul>
        {props.broken.map((row) => (
          <li key={row.id}>
            {row.label}: {FAILURE_WORDS[row.failureClass ?? ''] ?? 'it has stopped'}.
          </li>
        ))}
      </ul>
      <p>Reports generated now will understate the affected clients.</p>
      <button type="button" className="btn btn--sm btn--primary" data-fleet-fix onClick={props.fix}>
        Fix now
      </button>
    </div>
  );
}

function Tiles(props: { readonly fleet: ConnectionFleetResult }): ReactElement {
  const { counts } = props.fleet;
  return (
    <dl className="tiles">
      <div>
        <dt>Sources clean</dt>
        <dd>
          {counts.active} <span className="of">of {counts.all}</span>
        </dd>
      </div>
      <div>
        <dt>Degraded</dt>
        <dd>
          {counts.degraded} <span className="of">of {counts.all}</span>
        </dd>
      </div>
      <div>
        <dt>Broken</dt>
        <dd>
          {counts.broken} <span className="of">of {counts.all}</span>
        </dd>
      </div>
    </dl>
  );
}

function useFleet(client: OperationsClient): {
  readonly fleet: Fleet;
  readonly load: () => Promise<void>;
} {
  const [fleet, setFleet] = useState<Fleet>({ state: 'loading' });
  const load = useCallback(async (): Promise<void> => {
    const answer = await client.read<ConnectionFleetResult>('connection.fleet', {});
    if (isUnavailable(answer)) setFleet({ state: 'unavailable', because: answer.because });
    else if (isRefusal(answer))
      setFleet({ state: 'refused', because: answer.fixes[0] ?? answer.code });
    else setFleet({ state: 'shown', fleet: answer.value });
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  return { fleet, load };
}

/** Start a repair, then read the fleet again; a refusal is said on the row. */
function useRepair(
  client: OperationsClient,
  load: () => Promise<void>,
): {
  readonly repair: (row: ConnectionView) => void;
  readonly repairSaid: Readonly<Record<string, string>>;
} {
  const [repairSaid, setRepairSaid] = useState<Readonly<Record<string, string>>>({});
  const repair = (row: ConnectionView): void => {
    void (async () => {
      const answer = await client.mutate(
        'connector.repair',
        { connectionId: row.id },
        { expectedRevision: row.revision },
      );
      let said: string | undefined;
      if (isUnavailable(answer)) said = answer.because;
      else if (isRefusal(answer)) said = `${answer.code}: ${answer.fixes[0] ?? ''}`;
      setRepairSaid((before) => {
        const next = { ...before };
        if (said === undefined) delete next[row.id];
        else next[row.id] = said;
        return next;
      });
      await load();
    })();
  };
  return { repair, repairSaid };
}

function NotConnected(): ReactElement {
  return (
    <>
      <section data-section="003" data-not-connected="credentials-quota">
        <h2>003 Credentials &amp; quota</h2>
        <InDevelopment title="Token expiry and quota burn" owner="MP-14-7b" />
      </section>
      <section data-section="004" data-not-connected="data-quality">
        <h2>004 Data quality</h2>
        <InDevelopment title="Known gaps and restatement windows" owner="MP-14-7b" />
      </section>
      <section data-section="005" data-not-connected="band-health">
        <h2>005 Band health</h2>
        <InDevelopment title="Band health" owner="MP-14-7b" />
      </section>
    </>
  );
}

function Shown(props: {
  readonly fleet: ConnectionFleetResult;
  readonly now: number;
  readonly repair: (row: ConnectionView) => void;
  readonly repairSaid: Readonly<Record<string, string>>;
}): ReactElement {
  const { fleet } = props;
  const [view, setView] = useState<FleetView>(initialFleetView);
  const broken = fleet.connections.filter((row) => row.status === 'broken');
  // Fix now opens the repair flow for the sources the banner names: the
  // broken facet, with each of them open at its Repair button.
  const fix = (): void => {
    setView(broken.reduce((open, row) => toggleOpen(open, row.id), withFacet(view, 'broken')));
  };
  return (
    <>
      <section data-section="001">
        <h2>
          001 Fleet state{' '}
          <span className="t-2">
            {fleet.counts.all} sources · {fleet.counts.clientConnections} client connections
          </span>
        </h2>
        <Banner broken={broken} fix={fix} />
        <Tiles fleet={fleet} />
      </section>
      <section data-section="002">
        <h2>
          002 Connectors{' '}
          <span className="t-2">Agency-wide · filter, sort and open a row for its clients</span>
        </h2>
        <FleetTable
          rows={fleet.connections}
          counts={fleet.counts}
          view={view}
          setView={setView}
          now={props.now}
          repair={props.repair}
          repairSaid={props.repairSaid}
        />
      </section>
    </>
  );
}

export function ConnectionsScreen(props: {
  readonly client: OperationsClient;
  readonly now?: () => number;
}): ReactElement {
  const { client } = props;
  const now = (props.now ?? Date.now)();
  const { fleet, load } = useFleet(client);
  const { repair, repairSaid } = useRepair(client, load);
  const rows = fleet.state === 'shown' ? fleet.fleet.connections : [];
  return (
    <section className="page" data-screen="connections">
      <header className="page__head">
        <h1>Connections &amp; Signal</h1>
        <p className="marker" data-fleet-marker>
          {lastPass(rows)}
        </p>
      </header>
      {fleet.state === 'loading' ? <p role="status">Loading the fleet…</p> : null}
      {fleet.state === 'refused' ? (
        <Empty title="You are not permitted to see the connections." description={fleet.because} />
      ) : null}
      {fleet.state === 'unavailable' ? (
        <Empty title="The fleet could not be read." description={fleet.because} />
      ) : null}
      {fleet.state === 'shown' ? (
        <Shown fleet={fleet.fleet} now={now} repair={repair} repairSaid={repairSaid} />
      ) : null}
      <NotConnected />
      <SignalSections client={client} now={now} />
      <SkillCostingSection client={client} />
      <GraduationRegion client={client} />
    </section>
  );
}
