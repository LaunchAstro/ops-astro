// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal sections 006 to 008 (MP-14-8): grants, tripwires and
// the night round, fleet material above the per-client region. One read,
// `connection.signal`, draws all three, through `useRead` and `RecordState`
// as the fleet above it is: keyed on the grant, re-read on the rollup floor,
// and a read that did not succeed draws none of the three.
//
// Nothing here acts (CS-14.14: doors, navigation and view state). The only
// links are the night round's cites, which jump to a section on this page or
// to a task, and each filed tripwire's link into the one attention feed,
// drawn unavailable until MP-14-4 builds the feed. The Exceptions
// section a cite may name is MP-14-10's; until it is on the page that cite is
// flat text rather than a link to an anchor that is not there. The ceiling
// chip opens a clearance document that does not exist yet, so it is drawn
// unavailable too.

import { useEffect, useReducer, type ReactElement } from 'react';
import { Empty, SectionHead, StatusLine, type MarkTone } from '@launchastro/ui';
import type {
  ConnectionSignalResult,
  NightStepView,
  TripwireView,
} from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import type { RollupFloor } from '../../data/rollup-floor.ts';
import { useRead } from '../../data/use-read.ts';
import { pathTo } from '../../routes.ts';
import { RecordState } from '../../views/record-state.tsx';
import { CeilingChip, GrantsSection } from './signal-grants.tsx';
import { clock, nightLede, plural, stamp, tripwiresLede } from './signal-view.ts';

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
        <span className={armed ? 'chip chip--outline is-ok' : 'chip chip--outline is-warn'}>
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
    <section id="tripwires" data-section="007">
      <SectionHead index="007" title="Tripwires" right="What is watching" />
      <p className="tw__lede">
        {tripwiresLede(tripwireCounts.armed, tripwireCounts.cannotBeArmed)} Anything that fires and
        needs a person is filed in the one attention feed.
      </p>
      {tripwires.length === 0 ? (
        <p>No checks you can see are watching.</p>
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

/** The only task cite that links: a task key, as the migration shapes it. */
const TASK_KEY = /^T-[1-9][0-9]{0,17}$/u;

function Cite(props: { readonly cite: NonNullable<NightStepView['cite']> }): ReactElement {
  const { cite } = props;
  const href =
    cite.kind === 'task' && TASK_KEY.test(cite.ref ?? '')
      ? pathTo('agency:task-detail', { key: cite.ref ?? '' })
      : cite.kind === 'grants' || cite.kind === 'tripwires'
        ? `#${cite.kind}`
        : null;
  if (href === null) {
    return (
      <span
        data-night-cite
        title={
          cite.kind === 'exceptions'
            ? 'The exceptions section arrives with MP-14-10'
            : 'No task key to open'
        }
      >
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

/** A step's tone as the kit's timeline node, and in words where it was not plain. */
const STEP_TONE: Readonly<Record<NightStepView['tone'], MarkTone>> = {
  plain: 'idle',
  watch: 'warn',
  bad: 'bad',
};
const STEP_WORDS: Readonly<Record<NightStepView['tone'], string | null>> = {
  plain: null,
  watch: 'Worth a look: ',
  bad: 'Did not go cleanly: ',
};

function NightStep(props: { readonly step: NightStepView }): ReactElement {
  const { step } = props;
  const words = STEP_WORDS[step.tone];
  return (
    <li data-night-step={step.id}>
      <time className="mono">{clock(step.at)}</time>{' '}
      <span data-tone={step.tone}>
        <StatusLine tone={STEP_TONE[step.tone]} node />
      </span>{' '}
      {words === null ? null : <span className="visually-hidden">{words}</span>}
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
            {agent.liveGrants === 0 ? 'Idle' : `Holding ${plural(agent.liveGrants, 'grant')}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NightSection(props: { readonly signal: ConnectionSignalResult }): ReactElement {
  const round = props.signal.nightRound;
  return (
    <section id="night-round" data-section="008">
      <SectionHead index="008" title="The night round" right="23:00 to 08:10" />
      {round === null ? (
        <p data-night-lede>No night round you can see has run.</p>
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

/** How often the sections redraw on their own, so a countdown moves while a read waits. */
const REDRAW_MS = 30_000;

/** Nothing on the ledger at all: no grant, no tripwire, no round and no agent. */
const isEmpty = (signal: ConnectionSignalResult): boolean =>
  signal.grants.length === 0 &&
  signal.tripwires.length === 0 &&
  signal.nightRound === null &&
  signal.roster.length === 0;

export function SignalSections(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** Read on each draw: the sections refresh apart from the fleet around them. */
  readonly clock: () => number;
  readonly rollup?: RollupFloor;
}): ReactElement {
  const { client } = props;
  const { state, reload } = useRead<ConnectionSignalResult>({
    grantKey: props.grantKey,
    run: () => client.read<ConnectionSignalResult>('connection.signal', {}),
    isEmpty,
    ...(props.rollup === undefined ? {} : { rollup: props.rollup }),
    deps: [],
  });
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(redraw, REDRAW_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="secs" data-signal>
      <RecordState
        state={state}
        subject="signal"
        onRetry={reload}
        keep
        empty={
          <Empty
            title="No grants, tripwires or night round you can see yet."
            description="Grants join the ledger as agents are given work; the night round runs overnight."
          />
        }
      >
        {(signal) => (
          // RecordState wraps what it draws, so the column that spaces the
          // three sections sits inside it, as Access does.
          <div className="secs">
            <GrantsSection signal={signal} now={props.clock()} />
            <TripwiresSection signal={signal} />
            <NightSection signal={signal} />
          </div>
        )}
      </RecordState>
    </div>
  );
}
