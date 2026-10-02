// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's run on a task, as one story (MP-6-1).
//
// The Agent pane draws a run summary, a workflow, a gate and a lifecycle word,
// and each of them could be derived on its own from the stored lineage. Four
// derivations are four chances to disagree: a summary saying "At human gate"
// beside a gate box that is stale, or a workflow still running beside a
// rejected lineage. So every word the pane shows comes from `runStory`, which
// reads the stored projection (`task.read`'s proposals) once and answers one
// state. The pane never looks at the lineage, gate or reservation itself.
//
// Nothing here decides anything. A gate's staleness is a comparison of
// versions (the gate's version is not the lineage's head, or its deadline has
// passed on the server's clock, which the read already derived), never a
// timer in the browser. What the run staged is read in `agent-staged.ts`.

import { headReservation, heldMinorOf, unknownOf } from './run-projection.ts';
import type { RunLineage, RunVersion } from './run-projection.ts';
import type { GateBox, Job, JobState, RunState, RunStory, RunTone } from './run-story.ts';

export type { GateBox, Job, JobState, RunState, RunStory, RunTone } from './run-story.ts';

const WORDS: Readonly<Record<RunState, { word: string; tone: RunTone }>> = {
  'at-gate': { word: 'At human gate', tone: 'gate' },
  'gate-stale': { word: 'Gate stale', tone: 'bad' },
  'changes-requested': { word: 'Changes requested', tone: 'gate' },
  approved: { word: 'Approved', tone: 'run' },
  running: { word: 'Running', tone: 'run' },
  done: { word: 'Done', tone: 'done' },
  'unknown-outcome': { word: 'Outcome unknown', tone: 'bad' },
  dropped: { word: 'Dropped', tone: 'bad' },
  rejected: { word: 'Rejected', tone: 'bad' },
  cancelled: { word: 'Cancelled', tone: 'bad' },
};

function stateOf(lineage: RunLineage, head: RunVersion): RunState {
  if (lineage.state === 'rejected') return 'rejected';
  if (lineage.state === 'cancelled') return 'cancelled';
  const reservation = headReservation(lineage, head);
  if (reservation?.state === 'quarantined') return 'unknown-outcome';
  // T3b's unknown effect: held until a person records what happened (C54).
  if (reservation?.attempt?.state === 'liability_unknown') return 'unknown-outcome';
  // A hand-back's classifier abandons the hold under `handback_completed` and
  // leaves the lineage live; a dropped hand-back also marks its attempt dropped.
  if (reservation?.state === 'abandoned') {
    const handedBack = reservation.classifiedCause === 'handback_completed';
    return handedBack && reservation.attempt?.state !== 'dropped' ? 'done' : 'dropped';
  }
  // A hold the classifier settled at its calls' spend stopped as an abandoned one did.
  const stopped = ['abandoned', 'dropped'].includes(reservation?.attempt?.state ?? '');
  if (reservation?.state === 'actual' && stopped) return 'dropped';
  if (lineage.state === 'completed' || reservation?.state === 'actual') return 'done';
  if (reservation?.lease?.state === 'live') return 'running';
  const gate = head.gate;
  if (gate === null) return reservation === undefined ? 'gate-stale' : 'approved';
  if (gate.state === 'approved') return 'approved';
  if (gate.state === 'changes_requested') return 'changes-requested';
  if (gate.state === 'pending' && !gate.expired) return 'at-gate';
  return 'gate-stale';
}

const SENTENCES: Readonly<Record<RunState, string>> = {
  'at-gate': 'The agent has staged its work and is waiting on a person to decide.',
  'gate-stale':
    'The gate no longer matches the current version, so it cannot be approved. The run has to raise it again.',
  'changes-requested': 'Changes were requested. The agent revises within the approved scope.',
  approved: 'Approved. The work waits for its worker to pick it up.',
  running: 'The worker holds the run and is working it.',
  done: 'The run finished and handed its work back.',
  'unknown-outcome':
    'The worker stopped without saying whether the effect happened. Nothing is retried until a person checks.',
  dropped: 'The run was dropped before it finished. Its hold was released.',
  rejected: 'The proposal was rejected. Start a new attempt to try again.',
  cancelled: 'The run was cancelled. Start a new attempt to try again.',
};

const NEXT: Readonly<Record<RunState, string>> = {
  'at-gate': 'A person decides the gate',
  'gate-stale': 'The run raises a fresh gate',
  'changes-requested': 'The agent sends a revised version',
  approved: 'The worker picks it up',
  running: 'The worker hands it back',
  done: 'Nothing',
  'unknown-outcome': 'A person checks what happened',
  dropped: 'Start a new attempt',
  rejected: 'Start a new attempt',
  cancelled: 'Start a new attempt',
};

function gateBox(lineage: RunLineage, head: RunVersion, state: RunState): GateBox {
  // The gate drawn is the head version's; a gate on an older version is the
  // stale treatment, whatever its stored state says.
  const gated = [head, ...lineage.versions.slice(1)].find((version) => version.gate !== null);
  const gate = gated?.gate;
  if (gated === undefined || gate === null || gate === undefined) return { kind: 'none' };
  const onHead = gated.versionId === head.versionId;
  const expired = gate.expired || gate.state === 'expired';
  // A pending gate is armed only when the story is waiting on it: on a
  // lineage that has moved on (rejected, cancelled, running), a gate still
  // stored pending cannot be decided, and drawing it armed would tell a
  // different story from the summary (MP-6-1 one story).
  const pending = gate.state === 'pending' && !expired;
  const stale =
    !onHead ||
    gate.state === 'superseded' ||
    expired ||
    state === 'gate-stale' ||
    (pending && state !== 'at-gate');
  return {
    kind: stale ? 'stale' : pending ? 'armed' : 'decided',
    gateId: gate.id,
    versionId: gated.versionId,
    version: gated.version,
    digest: gate.payloadDigest,
    state: expired ? 'expired' : gate.state,
    round: gate.round,
    expiresAt: gate.expiresAt,
    invalidatedBy: stale
      ? expired
        ? 'Its deadline passed with no decision.'
        : onHead && gate.state !== 'superseded'
          ? 'The run moved on without it.'
          : `A newer version, v${String(head.version)}, replaced v${String(gated.version)}.`
      : null,
  };
}

function jobsOf(head: RunVersion, state: RunState, box: GateBox): readonly Job[] {
  const worked: JobState =
    state === 'running'
      ? 'running'
      : state === 'done'
        ? 'done'
        : state === 'dropped' || state === 'unknown-outcome'
          ? 'failed'
          : state === 'rejected' || state === 'cancelled'
            ? 'refused'
            : 'waiting';
  const checks: readonly Job[] = head.checks.map((check) => ({
    key: `check-${check.id}`,
    title: check.name,
    meta: `CHECK · ${check.outcome} · v${String(head.version)}`,
    state: check.outcome === 'passed' ? 'done' : check.outcome === 'failed' ? 'failed' : 'waiting',
    group: 'checks',
  }));
  const gateJob: readonly Job[] =
    box.kind === 'none'
      ? []
      : [
          {
            key: 'gate',
            title: 'Human approval',
            meta: `GATE · v${String(box.version)}`,
            state:
              box.kind === 'armed'
                ? 'pending'
                : box.kind === 'stale'
                  ? 'refused'
                  : box.state === 'approved'
                    ? 'approved'
                    : 'refused',
            group: null,
          },
        ];
  return [
    {
      key: 'work',
      title: head.purpose.replaceAll('_', ' '),
      meta: `WORK · typed output v${String(head.version)}`,
      state: worked,
      group: null,
    },
    ...checks,
    ...gateJob,
  ];
}

/**
 * Every attempt on the task, oldest first, each as one story. The newest
 * lineage is the current attempt, and the pane shows it unless a person opens
 * an earlier one (CS-6.6).
 */
export function runStories(proposals: readonly RunLineage[] | undefined): readonly RunStory[] {
  if (proposals === undefined) return [];
  // The read lists the newest lineage first; attempts count from the oldest.
  const oldestFirst = proposals.toReversed();
  return oldestFirst.flatMap((lineage, index) => {
    const head = lineage.versions[0];
    if (head === undefined) return [];
    const state = stateOf(lineage, head);
    const box = gateBox(lineage, head, state);
    const jobs = jobsOf(head, state, box);
    const passed = head.checks.filter((check) => check.outcome === 'passed').length;
    const reservation = headReservation(lineage, head);
    const { word, tone } = WORDS[state];
    return [
      {
        lineageId: lineage.lineageId,
        attempt: index + 1,
        current: index === oldestFirst.length - 1,
        state,
        tone,
        word,
        sentence: SENTENCES[state],
        progress:
          head.checks.length === 0
            ? 'No checks yet'
            : `${String(passed)} of ${String(head.checks.length)} checks passed`,
        currentJob:
          jobs.find((job) => job.state === 'running' || job.state === 'pending')?.title ?? 'None',
        blockedBy:
          box.kind === 'armed'
            ? 'Human approval'
            : box.kind === 'stale'
              ? 'A stale gate'
              : 'Nothing',
        nextAction: NEXT[state],
        head,
        gate: box,
        jobs,
        checks: head.checks,
        cancellable: lineage.state === 'live' && state !== 'done',
        heldMinor: heldMinorOf(lineage, head),
        actualMinor: reservation?.actualMinor ?? null,
        unknownAttempt: unknownOf(reservation),
      },
    ];
  });
}

/** How many request-changes rounds a gate allows before Escalate takes the place (CS-6.4). */
export const CHANGE_ROUNDS = 2;
