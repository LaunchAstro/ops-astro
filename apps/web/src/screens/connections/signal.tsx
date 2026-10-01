// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal sections 006 to 008 (MP-14-8): grants, tripwires and
// the night round, fleet material above the per-client region. One read,
// `connection.signal`, draws all three.
//
// Nothing here acts (CS-14.14: doors, navigation and view state). The only
// links are the night round's cites, which jump to a section on this page or
// to a task, and each filed tripwire's link into the one attention feed,
// drawn unavailable until MP-14-4 builds the feed. The Exceptions
// section a cite may name is MP-14-10's; until it is on the page that cite is
// flat text rather than a link to an anchor that is not there. The ceiling
// chip opens a clearance document that does not exist yet, so it is drawn
// unavailable too.

import { useEffect, useState, type ReactElement } from 'react';
import type {
  ConnectionSignalResult,
  NightStepView,
  TripwireView,
} from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import { pathTo } from '../../routes.ts';
import { CeilingChip, GrantsSection } from './signal-grants.tsx';
import { SectionHead } from './section-head.tsx';
import { clock, nightLede, plural, stamp, tripwiresLede } from './signal-view.ts';

type Signal =
  | { readonly state: 'loading' }
  | { readonly state: 'shown'; readonly signal: ConnectionSignalResult }
  | { readonly state: 'not shown'; readonly because: string };

function Fired(props: { readonly row: TripwireView }): ReactElement {
  const { row } = props;
  if (row.state === 'cannot_be_armed') {
    return <p data-tripwire-fired>Cannot be armed: {row.blockedReason}</p>;
  }
  if (row.lastFiredAt === null) return <p data-tripwire-fired>Has never fired</p>;
  return (
    <>
      <p data-tripwire-fired>
        {row.firedCount}× · last {stamp(row.lastFiredAt)}
      </p>
      <p data-tripwire-filed>
        {row.filedItem === null ? (
          `Filed nothing${row.filedNothing === null ? '' : `: ${row.filedNothing}`}`
        ) : (
          <a data-feed-link aria-disabled="true" title="The attention feed arrives with MP-14-4">
            Filed {row.filedItem} in the one feed
          </a>
        )}
      </p>
    </>
  );
}

function TripwireRow(props: { readonly row: TripwireView }): ReactElement {
  const { row } = props;
  const armed = row.state === 'armed';
  return (
    <li
      className={armed ? 'tw__row' : 'tw__row tw__row--dead'}
      data-tripwire={row.id}
      data-state={row.state}
    >
      <p>
        <strong>{row.what}</strong>{' '}
        <span className={armed ? 'chip chip--ok' : 'chip chip--warn'}>
          {armed ? 'Armed' : 'Cannot be armed'}
        </span>
      </p>
      <p>
        <span className="t-2">Fires when</span> {row.rule}
      </p>
      <p>
        <span className="t-2">Watching</span> {row.watching}
      </p>
      <Fired row={row} />
      {row.note === null ? null : <p className="t-2">{row.note}</p>}
    </li>
  );
}

function TripwiresSection(props: { readonly signal: ConnectionSignalResult }): ReactElement {
  const { tripwires, tripwireCounts } = props.signal;
  return (
    <section className="sec" id="tripwires" data-section="007">
      <SectionHead number="007" title="Tripwires" aside="Fleet · what is watching" />
      <p className="tw__lede">
        {tripwiresLede(tripwireCounts.armed, tripwireCounts.cannotBeArmed)} Anything that fires and
        needs a person is filed in the one attention feed.
      </p>
      {tripwires.length === 0 ? (
        <p>No checks are watching yet.</p>
      ) : (
        <ul className="card card--flush">
          {tripwires.map((row) => (
            <TripwireRow key={row.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Cite(props: { readonly cite: NonNullable<NightStepView['cite']> }): ReactElement {
  const { cite } = props;
  const href =
    cite.kind === 'task' && cite.ref !== null
      ? pathTo('agency:task-detail', { key: cite.ref })
      : cite.kind === 'grants' || cite.kind === 'tripwires'
        ? `#${cite.kind}`
        : null;
  if (href === null) {
    return (
      <span data-night-cite title="The exceptions section arrives with MP-14-10">
        {cite.label}
      </span>
    );
  }
  return (
    <a data-night-cite href={href}>
      {cite.label}
    </a>
  );
}

function NightStep(props: { readonly step: NightStepView }): ReactElement {
  const { step } = props;
  return (
    <li className="nr__step" data-night-step={step.id}>
      <time className="mono">{clock(step.at)}</time>{' '}
      <span className="nr__dot" data-tone={step.tone} aria-label={step.tone} />{' '}
      <strong>{step.what}</strong> <span className="t-2">{step.who}</span> {step.say}{' '}
      {step.cite === null ? null : <Cite cite={step.cite} />}
    </li>
  );
}

function Roster(props: { readonly signal: ConnectionSignalResult }): ReactElement {
  return (
    <div className="card card--flush nr__roster">
      <h3>The roster</h3>
      <ul>
        {props.signal.roster.map((agent) => (
          <li key={agent.agentId} data-roster={agent.agentId}>
            <strong>{agent.agentId.slice(0, 8)}</strong> <CeilingChip />{' '}
            {agent.active ? '' : 'Inactive · '}
            {agent.liveGrants === 0 ? 'Idle' : `Holding ${plural(agent.liveGrants, 'lease')}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NightSection(props: { readonly signal: ConnectionSignalResult }): ReactElement {
  const round = props.signal.nightRound;
  return (
    <section className="sec" id="night-round" data-section="008">
      <SectionHead number="008" title="The night round" aside="Fleet · 23:00 to 08:10" />
      {round === null ? (
        <p data-night-lede>No night round has run yet.</p>
      ) : (
        <>
          <p className="nr__lede" data-night-lede>
            {nightLede(round.roundOn, round.notClean)} The round is everything that happens before a
            person looks: it ends when the brief is handed over.
          </p>
          <ol className="nr card card--flush">
            {round.steps.map((step) => (
              <NightStep key={step.id} step={step} />
            ))}
          </ol>
        </>
      )}
      <Roster signal={props.signal} />
    </section>
  );
}

function useSignal(client: OperationsClient): Signal {
  const [signal, setSignal] = useState<Signal>({ state: 'loading' });
  useEffect(() => {
    void (async () => {
      const answer = await client.read<ConnectionSignalResult>('connection.signal', {});
      if (isUnavailable(answer)) setSignal({ state: 'not shown', because: answer.because });
      else if (isRefusal(answer))
        setSignal({ state: 'not shown', because: answer.fixes[0] ?? answer.code });
      else setSignal({ state: 'shown', signal: answer.value });
    })();
  }, [client]);
  return signal;
}

export function SignalSections(props: {
  readonly client: OperationsClient;
  readonly now: number;
}): ReactElement | null {
  const signal = useSignal(props.client);
  if (signal.state === 'loading') return null;
  if (signal.state === 'not shown') {
    return (
      <section data-section="006">
        <p>Grants, tripwires and the night round could not be read: {signal.because}</p>
      </section>
    );
  }
  return (
    <>
      <GrantsSection signal={signal.signal} now={props.now} />
      <TripwiresSection signal={signal.signal} />
      <NightSection signal={signal.signal} />
    </>
  );
}
