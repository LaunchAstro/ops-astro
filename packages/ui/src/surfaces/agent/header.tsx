// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent pane's top: the proposal header with its Reject and Cancel, the
// summary grid, and the job list (DA-01, DA-02, TA-03).

import type { ReactElement } from 'react';
import type { Job, RunStory } from '../../state/agent-run.ts';
import { words } from './format.ts';
import type { GateRef } from './gate.tsx';

export function ProposalHeader(props: {
  readonly story: RunStory;
  readonly busy: boolean;
  readonly onReject: (gate: GateRef) => void;
  readonly onCancel: (lineageId: string) => void;
}): ReactElement {
  const { story } = props;
  const box = story.gate;
  // Reject stops the proposal whatever round it is in, so it sits on the
  // proposal's header and not in the gate card (package 2 item 4).
  const rejectable = story.current && story.cancellable && box.kind === 'armed';
  return (
    <div className="sb__sh" data-agent="proposal-header">
      <span className="sb__k">Proposal · {words(story.head.purpose)}</span>
      <span className="btnrow">
        {rejectable && box.kind === 'armed' ? (
          <button
            className="btn btn--sm btn--secondary"
            type="button"
            data-agent="reject"
            disabled={props.busy}
            onClick={() => {
              props.onReject({ gateId: box.gateId, versionId: box.versionId });
            }}
          >
            Reject this proposal
          </button>
        ) : null}
        {story.current && story.cancellable && story.state === 'running' ? (
          <button
            className="btn btn--sm btn--secondary"
            type="button"
            data-agent="cancel"
            disabled={props.busy}
            onClick={() => {
              props.onCancel(story.lineageId);
            }}
          >
            Cancel the run
          </button>
        ) : null}
      </span>
    </div>
  );
}

function summaryCell(key: string, value: string, name: string): ReactElement {
  return (
    <div className="trs__c" data-summary={name}>
      <span className="tf__k">{key}</span>
      <span className="trs__v">{value}</span>
    </div>
  );
}

function jobRow(job: Job): ReactElement {
  return (
    <div className="wf__row" key={job.key} data-job={job.key} data-job-state={job.state}>
      <span className="wf__mark" data-tone={job.state} aria-hidden="true" />
      <div className="wf__body">
        <span className="wf__t">{job.title}</span>
        <span className="sbact__meta u-mono">{job.meta}</span>
      </div>
      <span className="spill wf__state" data-tone={job.state}>
        {job.state}
      </span>
    </div>
  );
}

export function Summary(props: { readonly story: RunStory }): ReactElement {
  const { story } = props;
  return (
    <div className="trs" data-tone={story.tone} data-agent="summary" data-run-state={story.state}>
      <div className="trs__top">
        <span className="sbact__meta u-mono">Attempt {story.attempt} · agent</span>
        <span className="spill" data-tone={story.tone} data-agent="state-word">
          {story.word}
        </span>
      </div>
      <p className="trs__say">{story.sentence}</p>
      <HeroStats story={story} />
      <div className="trs__grid">
        {summaryCell('Progress', story.progress, 'progress')}
        {summaryCell('Current job', story.currentJob, 'current-job')}
        {summaryCell('Blocked by', story.blockedBy, 'blocked-by')}
        {summaryCell('Next action', story.nextAction, 'next-action')}
      </div>
    </div>
  );
}

/**
 * MP-6-2: the run's figures, as the mockup's `runHero` derives them: jobs
 * complete out of the run's jobs, the checks recorded, once the run is handed
 * back the time it took, and the token units its model calls recorded. A cell
 * with nothing to show is left out, as the mockup leaves it out when unknown;
 * a run here meets its gate before it starts, so there is no "to the gate".
 */
function HeroStats(props: { readonly story: RunStory }): ReactElement {
  const { jobs, checks } = props.story;
  const done = jobs.filter((job) => job.state === 'done' || job.state === 'approved').length;
  const elapsed = elapsedOf(props.story.head.startedAt, props.story.head.endedAt);
  const units = props.story.head.tokenUnits;
  return (
    <div className="tph__stats">
      <div className="tph__stat" data-hero="jobs">
        <span className="tph__n">
          {done}
          <span className="tph__of"> / {jobs.length}</span>
        </span>
        <span className="tf__k">jobs complete</span>
      </div>
      <div className="tph__stat" data-hero="checks">
        <span className="tph__n">{checks.length}</span>
        <span className="tf__k">checks recorded</span>
      </div>
      {elapsed === null ? null : (
        <div className="tph__stat" data-hero="time">
          <span className="tph__n">{elapsed}</span>
          <span className="tf__k">elapsed</span>
        </div>
      )}
      {typeof units === 'number' ? (
        <div className="tph__stat" data-hero="tokens">
          <span className="tph__n">
            {units >= 1000 ? `${String(Math.round(units / 1000))}k` : String(units)}
          </span>
          <span className="tf__k">tokens spent</span>
        </div>
      ) : null}
    </div>
  );
}

/** The mockup's figure: whole minutes, at least one, as hours and minutes from an hour. */
function elapsedOf(startedAt: string | null | undefined, endedAt: string | null | undefined) {
  if (typeof startedAt !== 'string' || typeof endedAt !== 'string') return null;
  const span = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(span)) return null;
  const minutes = Math.max(1, Math.round(span / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

export function Workflow(props: {
  readonly jobs: readonly Job[];
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
}): ReactElement {
  const alone = props.jobs.filter((job) => job.group === null);
  const parallel = props.jobs.filter((job) => job.group !== null);
  return (
    <div className="wf" data-agent="workflow">
      <button
        className="wf__toggle"
        type="button"
        aria-expanded={props.open}
        data-agent="job-list"
        onClick={() => {
          props.onToggle(!props.open);
        }}
      >
        <span className="sb__k u-mono">View {props.jobs.length}-job workflow</span>
      </button>
      <div className="wf__list" hidden={!props.open}>
        {alone.slice(0, 1).map((job) => jobRow(job))}
        {parallel.length === 0 ? null : (
          <div className="wf__par" data-agent="parallel">
            <span className="sbact__meta u-mono wf__parlab">Run in parallel</span>
            {parallel.map((job) => jobRow(job))}
          </div>
        )}
        {alone.slice(1).map((job) => jobRow(job))}
      </div>
    </div>
  );
}
