// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent pane (MP-6-1, mockup S3 DA-01 to DA-07, TA-03): the run on a task,
// its workflow, what it staged, and the gate on the exact version.
//
// Every word comes from `runStories` (`state/agent-run.ts`), so the summary,
// the workflow, the gate box and the lifecycle word tell one story. The pane
// decides nothing itself: the gate box's two controls, the header's "Reject
// this proposal" and Cancel hand the exact gate and version the read showed to
// the caller, which sends them through the real decide path. The mockup's
// demonstration state is not ported (R44).

import { useState, type ReactElement } from 'react';
import {
  CHANGE_ROUNDS,
  runStories,
  safeHref,
  shippedOf,
  stagedOf,
  type GateBox,
  type Job,
  type RunLineage,
  type RunStory,
  type Staged,
} from '../state/agent-run.ts';

export type GateDecision = 'approve' | 'request_changes';

export interface AgentPaneProps {
  /** `task.read`'s proposals; absent on a read that carries none. */
  readonly lineages: readonly RunLineage[] | undefined;
  /** What approving the gate will do, in the server's words; null when it has not said. */
  readonly effect: string | null;
  /** A person's name for an id the decision chain carries. */
  readonly nameOf: (personId: string) => string;
  /** Whether the job list starts open: the person's own saved preference (CS-6.2). */
  readonly jobListOpen: boolean;
  readonly onJobList: (open: boolean) => void;
  readonly busy: boolean;
  /** The server's refusal of the last action, quoted as it came. */
  readonly refusal: string | null;
  readonly onDecide: (
    gate: { readonly gateId: string; readonly versionId: string },
    decision: GateDecision,
  ) => void;
  readonly onReject: (gate: { readonly gateId: string; readonly versionId: string }) => void;
  readonly onCancel: (lineageId: string) => void;
}

const shortDigest = (digest: string): string => digest.slice(0, 12);

const money = (minor: number, currency: string): string =>
  `${currency} ${(minor / 100).toFixed(2)}`;

export function AgentPane(props: AgentPaneProps): ReactElement {
  const stories = runStories(props.lineages);
  const current = stories.at(-1);
  const [opened, setOpened] = useState<string | null>(null);
  if (current === undefined) {
    return (
      <section className="agent" data-agent="invitation">
        <p className="sb__say">
          Nothing has been handed to the agent on this task yet. Write a brief to tell it what to
          do, and it proposes a run for a person to approve before anything happens.
        </p>
      </section>
    );
  }
  const shown = stories.find((story) => story.lineageId === opened) ?? current;
  return (
    <section className="agent" data-agent="pane" data-agent-lineage={shown.lineageId}>
      <ProposalHeader
        story={shown}
        busy={props.busy}
        onReject={props.onReject}
        onCancel={props.onCancel}
      />
      {props.refusal === null ? null : (
        <p className="field__error" role="alert" data-agent="refusal">
          {props.refusal}
        </p>
      )}
      <div className="sb__sh">
        <span className="sb__k">Current run</span>
        <span className="sbact__meta u-mono" data-agent="run-id">
          {shown.head.runId ?? 'not planned'}
        </span>
      </div>
      <Summary story={shown} />
      <Workflow jobs={shown.jobs} open={props.jobListOpen} onToggle={props.onJobList} />
      <StagedOutput story={shown} />
      <Gate
        story={shown}
        effect={props.effect}
        busy={props.busy}
        nameOf={props.nameOf}
        decisions={
          (props.lineages ?? []).find((lineage) => lineage.lineageId === shown.lineageId)
            ?.decisions ?? []
        }
        onDecide={props.onDecide}
      />
      <Attempts stories={stories} shown={shown} onOpen={setOpened} />
    </section>
  );
}

function ProposalHeader(props: {
  readonly story: RunStory;
  readonly busy: boolean;
  readonly onReject: AgentPaneProps['onReject'];
  readonly onCancel: AgentPaneProps['onCancel'];
}): ReactElement {
  const { story } = props;
  const box = story.gate;
  // Reject stops the proposal whatever round it is in, so it sits on the
  // proposal's header and not in the gate card (package 2 item 4).
  const rejectable = story.current && story.cancellable && box.kind === 'armed';
  return (
    <div className="sb__sh" data-agent="proposal-header">
      <span className="sb__k">Proposal · {story.head.purpose.replace(/_/gu, ' ')}</span>
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

function gateFact(key: string, value: ReactElement | string, name: string): ReactElement {
  return (
    <div className="sout__row" data-gate-fact={name}>
      <span className="tf__k">{key}</span>
      <span className="sb__state">{value}</span>
    </div>
  );
}

function Summary(props: { readonly story: RunStory }): ReactElement {
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
      <div className="trs__grid">
        {summaryCell('Progress', story.progress, 'progress')}
        {summaryCell('Current job', story.currentJob, 'current-job')}
        {summaryCell('Blocked by', story.blockedBy, 'blocked-by')}
        {summaryCell('Next action', story.nextAction, 'next-action')}
      </div>
    </div>
  );
}

function Workflow(props: {
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
        {alone.slice(0, 1).map(jobRow)}
        {parallel.length === 0 ? null : (
          <div className="wf__par" data-agent="parallel">
            <span className="sbact__meta u-mono wf__parlab">Run in parallel</span>
            {parallel.map(jobRow)}
          </div>
        )}
        {alone.slice(1).map(jobRow)}
      </div>
    </div>
  );
}

function StagedOutput(props: { readonly story: RunStory }): ReactElement {
  const { head } = props.story;
  const staged = stagedOf(head);
  const shipped = shippedOf(head);
  return (
    <div className="sout" data-agent="staged">
      <div className="sb__sh">
        <span className="sb__k">
          {shipped === null
            ? 'Staged output'
            : shipped.rolledBackAt === null
              ? `Live · since ${shipped.at}`
              : `Was live · rolled back ${shipped.rolledBackAt}`}
        </span>
        <span className="sbact__meta">built · nothing published</span>
      </div>
      {staged === null ? (
        <p className="sout__say" data-staged="none">
          Nothing was staged for this version.
        </p>
      ) : (
        <div className="sout__box" data-staged={staged.kind}>
          <StagedKind staged={staged} />
        </div>
      )}
      {shipped === null ? (
        <p className="sout__say">Staged only. Nothing has been applied.</p>
      ) : (
        <div className="sout__box" data-agent="shipped">
          <div className="sout__row">
            <span className="tf__k">Closed against</span>
            <span className="sout__v">{shipped.artefact}</span>
          </div>
          <div className="sout__row">
            <span className="tf__k">Snapshot</span>
            <span className="sout__v" data-agent="snapshot">
              {shipped.snapshot}
            </span>
          </div>
          {/* DA-06: Roll back waits for an executor that can restore, and
              then raises a reversal through its own gate; it is never an undo
              in place (R78). Until then it is shown unavailable, with why. */}
          <button
            className="btn btn--secondary btn--sm"
            type="button"
            disabled
            data-agent="roll-back"
          >
            Roll back to {shipped.snapshot}
          </button>
          <span className="sbact__meta" data-agent="roll-back-reason">
            Roll back is unavailable: this run’s executor cannot restore yet. When it can, a roll
            back is a new request with its own approval and receipt.
          </span>
        </div>
      )}
    </div>
  );
}

function StagedKind(props: { readonly staged: Staged }): ReactElement {
  const { staged } = props;
  switch (staged.kind) {
    case 'diff':
      return (
        <div className="sout__diff">
          <span className="sout__where">{staged.where}</span>
          <div className="sout__d sout__d--was">
            <span className="tf__k">Now</span>
            <span className="sout__t">{staged.was}</span>
          </div>
          <div className="sout__d sout__d--will">
            <span className="tf__k">Would become</span>
            <span className="sout__t">{staged.will}</span>
          </div>
        </div>
      );
    case 'pr':
      return (
        <div className="sout__row">
          <span className="sout__v">
            {staged.repo} #{staged.number}
          </span>
          <ArtefactLink href={staged.href} className="sout__t">
            {staged.title}
          </ArtefactLink>
          <span className="sout__meta">
            {staged.files} files <span className="sout__adds">+{staged.adds}</span>{' '}
            <span className="sout__dels">−{staged.dels}</span> · {staged.checks}
          </span>
        </div>
      );
    case 'ad':
      return (
        <div className="sout__ads">
          <span className="sout__v">{staged.account}</span>
          {staged.groups.map((group) => (
            <div className="sout__ad" key={group.name}>
              <span className="sout__adname">
                {group.name} {group.paused ? <span className="spill">Paused</span> : null}
              </span>
              <span className="sout__band">{group.band}</span>
            </div>
          ))}
          <span className="sout__meta">{staged.spend}</span>
        </div>
      );
    case 'preview':
      return (
        <div className="sout__row">
          <ArtefactLink href={staged.url} className="sout__v">
            {staged.url}
          </ArtefactLink>
          <span className="sout__meta">{staged.built}</span>
          <span className="sout__t">{staged.note}</span>
        </div>
      );
  }
}

/** The staged artefact, opened in a new tab to inspect before deciding (CS-6.3), when its address is safe to open. */
function ArtefactLink(props: {
  readonly href: string;
  readonly className: string;
  readonly children: string;
}): ReactElement {
  const href = safeHref(props.href);
  return href === null ? (
    <span className={props.className} data-agent="artefact-unlinked">
      {props.children}
    </span>
  ) : (
    <a
      className={props.className}
      href={href}
      target="_blank"
      rel="noreferrer"
      data-agent="artefact"
    >
      {props.children}
    </a>
  );
}

function Gate(props: {
  readonly story: RunStory;
  readonly effect: string | null;
  readonly busy: boolean;
  readonly nameOf: AgentPaneProps['nameOf'];
  readonly decisions: RunLineage['decisions'];
  readonly onDecide: AgentPaneProps['onDecide'];
}): ReactElement | null {
  const box: GateBox = props.story.gate;
  if (box.kind === 'none') return null;
  const stale = box.kind === 'stale';
  const last = props.decisions.at(-1);
  const escalate = box.round >= CHANGE_ROUNDS;
  const { head } = props.story;
  return (
    <div
      className={stale ? 'gatebox gatebox--stale' : 'gatebox'}
      data-agent="gate"
      data-gate-kind={box.kind}
      data-gate-id={box.gateId}
    >
      <div className={stale ? 'gate' : 'gate gate--armed'}>
        <span className="gate__mark" aria-hidden="true" />
        <div>
          <div className="gate__word">{stale ? 'Gate stale' : 'Human approval gate'}</div>
          <p className="gate__say">
            {head.purpose.replace(/_/gu, ' ')}, waiting on a person with the gate’s authority.
          </p>
        </div>
      </div>
      <div className="sout__box">
        {gateFact(
          'Exact artefact',
          <>
            v{box.version}{' '}
            <span className="sbact__meta u-mono" title={box.digest} data-gate="digest">
              {shortDigest(box.digest)}
            </span>
          </>,
          'artefact',
        )}
        {gateFact(
          'Approval unlocks',
          props.effect ?? `The run continues, within ${money(head.maximumMinor, head.currency)}.`,
          'unlocks',
        )}
        {box.kind === 'armed'
          ? gateFact('Why it waits', 'Nothing runs until a person decides this version.', 'waits')
          : null}
        {stale
          ? gateFact(
              'Invalidated',
              box.invalidatedBy ?? 'It no longer matches the run.',
              'invalidated',
            )
          : null}
      </div>
      <div className="gatebox__acts" data-agent="gate-actions">
        {box.kind === 'armed' ? (
          <>
            {escalate ? (
              <button
                className="btn btn--sm btn--secondary"
                type="button"
                disabled
                data-gate-action="escalate"
              >
                Escalate
              </button>
            ) : (
              <button
                className="btn btn--sm btn--secondary"
                type="button"
                data-gate-action="request_changes"
                disabled={props.busy}
                onClick={() => {
                  props.onDecide(
                    { gateId: box.gateId, versionId: box.versionId },
                    'request_changes',
                  );
                }}
              >
                Request changes
              </button>
            )}
            <button
              className="btn btn--sm btn--primary"
              type="button"
              data-gate-action="approve"
              disabled={props.busy}
              onClick={() => {
                props.onDecide({ gateId: box.gateId, versionId: box.versionId }, 'approve');
              }}
            >
              Approve exact v{box.version}
            </button>
          </>
        ) : stale ? (
          <span className="sbact__meta" data-gate="stale">
            A stale gate cannot be approved. The run has to raise it again against the current
            version.
          </span>
        ) : last === undefined ? null : (
          <span className="sbact__meta" data-gate="decided">
            {last.decision.replace(/_/gu, ' ')} by {props.nameOf(last.decidedByPersonId)} at{' '}
            {last.decidedAt}
          </span>
        )}
      </div>
    </div>
  );
}

function Attempts(props: {
  readonly stories: readonly RunStory[];
  readonly shown: RunStory;
  readonly onOpen: (lineageId: string | null) => void;
}): ReactElement | null {
  const current = props.stories.at(-1);
  const restartable =
    current !== undefined &&
    ['rejected', 'cancelled', 'dropped', 'unknown-outcome'].includes(current.state);
  if (props.stories.length < 2 && !restartable) return null;
  return (
    <div className="sb__sect" data-agent="attempts">
      <div className="sb__sh">
        <span className="sb__k">Attempts</span>
      </div>
      {props.stories.map((story) => (
        <button
          key={story.lineageId}
          className="sbact__row"
          type="button"
          aria-pressed={story.lineageId === props.shown.lineageId}
          data-attempt={story.attempt}
          onClick={() => {
            props.onOpen(story.current ? null : story.lineageId);
          }}
        >
          Attempt {story.attempt} · {story.word} · held{' '}
          {money(story.heldMinor, story.head.currency)}
          {story.actualMinor === null
            ? ''
            : ` · spent ${money(story.actualMinor, story.head.currency)}`}
        </button>
      ))}
      {restartable ? (
        <p className="sbact__meta" data-agent="start-unavailable">
          <button className="btn btn--sm" type="button" disabled data-agent="start">
            Start a new attempt
          </button>{' '}
          Start is unavailable here until the sidebar chat can accept a plan for it.
        </p>
      ) : null}
    </div>
  );
}
