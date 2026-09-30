// SPDX-License-Identifier: AGPL-3.0-only
//
// The token panel (MP-6-5, DA-08, DA-09, DS-TASK-9): the task's allowance,
// what it was built from, what was spent against it and one row per run, from
// the reservation ledger `task.read` carries. The allowance is money in the
// envelope's currency, because that is what the ledger reserves.
//
// It writes nothing. The skill chips are doors to the Docs panel, drawn
// unavailable with their reason until that panel exists (MP-7-6 opens them);
// the data-source link is drawn only for an http or https address, since the
// evidence it comes from is the agent's own writing. AW-05's stops are shown
// here, each run's latest with its count and, after the third, the one
// consolidated decision (`stops.tsx`); answering them is C54's, below.

import { useId, type ReactElement } from 'react';
import type { RunLineage } from '../../state/run-projection.ts';
import { safeHref } from '../../state/agent-staged.ts';
import {
  latestStops,
  tokenStory,
  type LedgerSkill,
  type LedgerSource,
  type TaskLedger,
  type TokenRun,
  type TokenStory,
} from '../../state/token-ledger.ts';
import { money, words } from './format.ts';
import { StopStates } from './stops.tsx';

const SKILL_REASON =
  'Skills open in the Docs panel, which is not on this page yet. Each chip names the skill the run used.';

function SkillChips(props: {
  readonly skills: readonly LedgerSkill[];
  readonly reasonId: string;
}): ReactElement | null {
  if (props.skills.length === 0) return null;
  return (
    <span className="tokpanel__chips">
      {props.skills.map((skill, index) => (
        <button
          // eslint-disable-next-line react/no-array-index-key -- two skills may share a name; order is the evidence's
          key={`${index}-${skill.name}`}
          type="button"
          className="u-pill tokchip"
          data-tokens="skill"
          disabled
          aria-describedby={props.reasonId}
        >
          {skill.name}
        </button>
      ))}
    </span>
  );
}

function Source(props: { readonly source: LedgerSource }): ReactElement {
  const href = safeHref(props.source.href);
  return (
    <div className="tokpanel__src">
      <span className="tf__k">Data source</span>
      {href === null ? (
        <span data-tokens="source">{props.source.label}</span>
      ) : (
        <a data-tokens="source" href={href} target="_blank" rel="noopener noreferrer">
          {props.source.label}
        </a>
      )}
    </div>
  );
}

function RunRow(props: {
  readonly run: TokenRun;
  readonly currency: string;
  readonly reasonId: string;
}): ReactElement {
  const { run } = props;
  return (
    <div className="tokrun" data-token-run={run.reservationId} data-run-state={run.state}>
      <span className="tokrun__dot" data-outcome={run.state} aria-hidden="true" />
      <span className="tokrun__model">{run.runId}</span>
      <span className="tokrun__k">{words(run.state)}</span>
      <span className="tokrun__io">
        <span className="tokrun__n" data-run="held">
          {money(run.heldMinor, props.currency)}
        </span>
        <span className="tokrun__k">held</span>
        <span className="tokrun__n" data-run="spent">
          {run.actualMinor === null ? 'not settled' : money(run.actualMinor, props.currency)}
        </span>
        <span className="tokrun__k">spent</span>
      </span>
      {run.classifiedCause === null ? null : (
        <span className="tokrun__when">{words(run.classifiedCause)}</span>
      )}
      {run.skills.length === 0 ? null : (
        <span className="tokrun__skills">
          <SkillChips skills={run.skills} reasonId={props.reasonId} />
        </span>
      )}
    </div>
  );
}

type Tracked = Extract<TokenStory, { readonly kind: 'tracked' }>;

function Allowance(props: { readonly story: Tracked; readonly reasonId: string }): ReactElement {
  const { envelope } = props.story;
  return (
    <>
      <div className="tokpanel__est">
        <span className="tf__k">Allowance</span>
        <span className="tokest__n" data-tokens="allowance">
          {money(envelope.maximumMinor, envelope.currency)}
        </span>
        <span className="tokpanel__by" data-tokens="opened-by">
          {props.story.openedByVersion === null
            ? 'approved on a version this read does not show'
            : `approved on version ${String(props.story.openedByVersion)}`}
        </span>
      </div>
      <div className="tokpanel__sk" data-tokens="composed">
        <span className="tf__k">Composed from</span>
        <span className="tokpanel__by" data-tokens="cap">
          {`the ${envelope.cap.key} cap, limit ${money(envelope.cap.limitMinor, envelope.cap.currency)}`}
        </span>
        <SkillChips skills={props.story.skills} reasonId={props.reasonId} />
      </div>
    </>
  );
}

function Spend(props: { readonly story: Tracked }): ReactElement {
  const { envelope, overMinor, runs } = props.story;
  const cur = envelope.currency;
  return (
    <>
      {envelope.maximumMinor > 0 ? (
        <div className="tt__bar" data-tokens="bar">
          <div
            className={overMinor > 0 ? 'tt__fill is-over' : 'tt__fill'}
            style={{ width: `${String(props.story.percent)}%` }}
          />
        </div>
      ) : null}
      <div className="toksplit">
        <span className="tf__k">Spent</span>
        <span className="tokrun__n" data-tokens="spent">
          {money(envelope.actualMinor, cur)}
        </span>
        <span className="tokrun__k" data-tokens="runs">
          {`${String(runs.length)} run${runs.length === 1 ? '' : 's'}`}
        </span>
        <span className="tokrun__k" data-tokens="held">
          {`${money(envelope.heldMinor, cur)} held`}
        </span>
        {overMinor > 0 ? (
          <span className="brn__over" data-tokens="over" data-tone="danger">
            {`${money(overMinor, cur)} over`}
          </span>
        ) : null}
      </div>
    </>
  );
}

function Runs(props: { readonly story: Tracked; readonly reasonId: string }): ReactElement {
  const { runs, envelope } = props.story;
  return runs.length === 0 ? (
    <p className="tokempty__say">Nothing has run against this allowance yet.</p>
  ) : (
    <div className="tokruns">
      {runs.map((run) => (
        <RunRow
          key={run.reservationId}
          run={run}
          currency={envelope.currency}
          reasonId={props.reasonId}
        />
      ))}
    </div>
  );
}

const NO_ALLOWANCE = (
  <section className="tokempty" data-agent="tokens" data-tokens="none">
    <span className="sb__k">Token tracked</span>
    <p className="sb__state">No allowance on this task yet.</p>
    <p className="tokempty__say">
      An allowance is set when a person approves a run on this task. Nobody types one.
    </p>
  </section>
);

export function TokenTracked(props: {
  readonly ledger: TaskLedger | null;
  readonly lineages: readonly RunLineage[];
}): ReactElement | null {
  const reasonId = useId();
  if (props.ledger === null) return null;
  const story = tokenStory(props.ledger, props.lineages);
  if (story.kind === 'none') return NO_ALLOWANCE;
  const { envelope } = story;
  const showsReason = story.skills.length > 0 || story.runs.some((run) => run.skills.length > 0);
  return (
    <section className="tokpanel" data-agent="tokens" data-tokens="tracked">
      <div className="sb__sh">
        <span className="sb__k">Token tracked</span>
        <span className="sbact__meta" data-tokens="head">
          {`${money(envelope.actualMinor, envelope.currency)} of ${money(envelope.maximumMinor, envelope.currency)}`}
        </span>
      </div>
      <Allowance story={story} reasonId={reasonId} />
      <Spend story={story} />
      {story.dataSource === null ? null : <Source source={story.dataSource} />}
      <Runs story={story} reasonId={reasonId} />
      <StopStates stops={latestStops(props.ledger)} />
      {showsReason ? (
        <p className="tokempty__say" id={reasonId} data-tokens="skill-reason">
          {SKILL_REASON}
        </p>
      ) : null}
    </section>
  );
}
