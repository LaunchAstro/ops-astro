// SPDX-License-Identifier: AGPL-3.0-only
//
// The operational log (MP-6-2, TA-06, "append-only evidence"): every event
// the task's runs recorded, as `task.execution` returns them, one row each in
// the record's own order (`position`). A row names the job of the plan its run
// was proposed under (AW-04's plan record, as the read places the run:
// `JOB-01` is that plan's first step), the event in words and its time, and the
// job's title. The plan's own run is the plan; a run under no step of its plan
// is logged as outside it.
//
// Rows are keyed by the event, drawn from the event and the plan its run was
// proposed under, never the plan projected now, so a later read, a re-plan
// included, only adds rows after the drawn ones: nothing in a row depends on
// what happened after it. Every word is drawn as text.

import type { ReactElement } from 'react';
import { Empty } from '../../primitives/Absence.tsx';
import { words } from './format.ts';

/** A bound plan record a run was proposed under, with its steps (`task.execution`'s `plans`). */
export interface ActivityPlan {
  readonly planRecordId: string;
  readonly steps: readonly { readonly key: string; readonly title: string }[];
}

/** One durable event with its run's placement (`task.execution`'s `events`). */
export interface ActivityEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly position: number;
  readonly kind: string;
  readonly at: string;
  readonly placement: {
    readonly planRecordId: string | null;
    readonly stepKey: string | null;
    readonly planRun: boolean;
  };
}

/** What the log draws: the events and the plans their runs were proposed under. */
export interface RunActivity {
  readonly plans: readonly ActivityPlan[];
  readonly events: readonly ActivityEvent[];
}

const jobLabel = (index: number): string => `JOB-${String(index + 1).padStart(2, '0')}`;

/** `2026-09-30 10:00`, in UTC, as the record keeps it. */
const minuteOf = (at: string): string => at.slice(0, 16).replace('T', ' ');

export function Activity(props: {
  readonly activity: RunActivity;
  readonly hasRun: boolean;
}): ReactElement {
  const { plans, events } = props.activity;
  const ordered = events.toSorted((left, right) => left.position - right.position);
  return (
    <section data-agent="log">
      <div className="sb__sh">
        <span className="sb__k">Operational activity</span>
        <span className="sbact__meta">append-only evidence</span>
      </div>
      {props.hasRun ? null : (
        <Empty look="inline" title="No run, so there is nothing operational to log yet." />
      )}
      {props.hasRun && ordered.length === 0 ? (
        <Empty look="inline" title="This run has recorded no steps." />
      ) : null}
      {props.hasRun && ordered.length > 0 ? (
        <div>
          {ordered.map((each) => (
            <Row event={each} job={jobOf(plans, each)} key={each.eventId} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface Job {
  readonly label: string;
  readonly title: string | null;
}

/** The row's job, from its run's own plan: the plan itself, one of its steps, or outside it. */
function jobOf(plans: readonly ActivityPlan[], event: ActivityEvent): Job {
  const { planRecordId, stepKey, planRun } = event.placement;
  const plan = plans.find((each) => each.planRecordId === planRecordId);
  if (plan !== undefined && planRun) return { label: 'The plan', title: null };
  const index = plan?.steps.findIndex((step) => step.key === stepKey) ?? -1;
  const step = plan?.steps[index];
  if (step === undefined) return { label: 'Outside the plan', title: null };
  return { label: jobLabel(index), title: step.title };
}

function Row(props: { readonly event: ActivityEvent; readonly job: Job }): ReactElement {
  const { event, job } = props;
  return (
    <div className="sbact__row" data-log="row" data-log-event={event.eventId}>
      <span className="sbact__meta u-mono">
        <span data-log="job">{job.label}</span>
        {` · ${words(event.kind)} · ${minuteOf(event.at)}`}
      </span>
      {job.title === null ? null : <span data-log="title">{job.title}</span>}
    </div>
  );
}
