// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import {
  Avatar,
  Chip,
  Empty,
  ReviewCard,
  Icon,
  dueWords,
  estimateWords,
  type ProjectRow,
} from '@launchastro/ui';
import type {
  TaskReadResult,
  InternalTaskDetail,
  TaskBoardResult,
} from '../../../../../packages/core-wire/src/index.ts';
import type { CallResult, OperationsClient } from '../../operations/client.ts';
import { useRead } from '../../data/use-read.ts';
import { RecordState } from '../../views/record-state.tsx';
import { describeRefusal } from '../../records/submit.ts';
import { pathTo } from '../../routes.ts';
import { clientsAt } from '../../client-address.ts';
import type { BoardPanelHost } from '../projects-row.ts';
import { reviewSummary } from './review-summary.ts';

interface Entry {
  readonly row: ProjectRow;
  readonly answer: CallResult<TaskReadResult>;
}
interface Props {
  readonly rows: readonly ProjectRow[];
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly taskPanel: BoardPanelHost | undefined;
  readonly changes: number;
  readonly snapshot: TaskBoardResult;
}

export function ReviewOverview(props: Props): ReactElement {
  const identity = props.rows.map((row) => `${row.id}:${row.revision ?? ''}`).join('|');
  const read = useRead<readonly Entry[]>({
    grantKey: props.grantKey,
    run: async () => ({
      ok: true,
      value: await Promise.all(
        props.rows.map(async (row) => ({
          row,
          answer: await props.client.read<TaskReadResult>('task.read', { recordId: row.id }),
        })),
      ),
    }),
    deps: [props.client, identity, props.changes, props.snapshot],
  });
  if (!read.own)
    return (
      <p className="rq__say" role="status">
        Loading review details…
      </p>
    );
  return (
    <RecordState state={read.state} subject="review details" onRetry={read.reload}>
      {(entries) => <ReviewList entries={entries} taskPanel={props.taskPanel} />}
    </RecordState>
  );
}

function detailOf(entry: Entry) {
  const answer = entry.answer;
  return 'value' in answer &&
    'task' in answer.value &&
    'client' in answer.value.task &&
    answer.value.task.id === entry.row.id
    ? answer.value.task
    : null;
}

function ReviewList(props: {
  readonly entries: readonly Entry[];
  readonly taskPanel: BoardPanelHost | undefined;
}) {
  const entries = props.entries.toSorted((a, b) =>
    (a.row.due ?? '9999').localeCompare(b.row.due ?? '9999'),
  );
  const summaries = entries.flatMap((entry) => {
    const task = detailOf(entry);
    return task === null ? [] : [reviewSummary(task)];
  });
  const staged = summaries.filter((summary) => summary.kind === 'staged').length;
  const proposed = summaries.filter((summary) => summary.kind === 'proposed').length;
  const counts = [
    staged ? `${staged} built and staged` : '',
    proposed ? `${proposed} proposed` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="rq" data-review-overview>
      {entries.length === 0 ? (
        <Empty
          title="Nothing is waiting for your decision."
          description="Press Review again to go back to every task."
        />
      ) : (
        <>
          <p className="rq__say">
            {entries.length} waiting on you.{counts === '' ? '' : ` ${counts}.`}
          </p>
          {entries.map((entry) => (
            <ReviewEntry key={entry.row.id} entry={entry} taskPanel={props.taskPanel} />
          ))}
        </>
      )}
    </div>
  );
}

function ReviewEntry(props: {
  readonly entry: Entry;
  readonly taskPanel: BoardPanelHost | undefined;
}) {
  const { row, answer } = props.entry;
  const task = detailOf(props.entry);
  const summary = task === null ? null : reviewSummary(task);
  const unavailable =
    'value' in answer
      ? 'Review details are not available for this task.'
      : 'unavailable' in answer
        ? answer.because
        : describeRefusal(answer);
  const open = (door: 'agent' | 'reply') => {
    if (props.taskPanel === undefined)
      window.location.assign(pathTo('agency:task-detail', { key: row.key }));
    else props.taskPanel.open(row.key, door, door === 'reply' ? 'all' : undefined);
  };
  const estimate = row.estimate === null ? null : estimateWords(row.estimate);
  const figures = [
    estimate === null ? '' : `Est ${estimate.text}${estimate.tokens ? ' tokens' : ''}`,
    row.due === null ? '' : `Due ${dueWords(row.due, row.completed, new Date()).text}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <ReviewCard
      title={row.name}
      figures={figures}
      lead={<ReviewLead row={row} task={task} clearances={summary?.clearances ?? []} />}
      shows={summary?.shows ?? ''}
      action={summary?.action ?? ''}
      needs={summary?.needs ?? <span role="alert">{unavailable}</span>}
      skills={summary?.skills ?? []}
      onReview={summary?.canReview ? () => open('agent') : undefined}
      onDiscuss={() => open('reply')}
      onPlan={() => open('agent')}
    />
  );
}

function ReviewLead({
  row,
  task,
  clearances,
}: {
  readonly row: ProjectRow;
  readonly task: InternalTaskDetail | null;
  readonly clearances: readonly string[];
}) {
  return (
    <>
      {task?.proposals.length || row.assignee?.agent ? (
        <span className="rq__agent" role="img" aria-label="Agent">
          A
        </span>
      ) : (
        <Avatar name={row.assignee?.name ?? 'Unassigned'} />
      )}
      {task?.client ? (
        <a className="chip chip--outline" href={clientsAt(task.client)}>
          {row.client ?? 'Client'}
          <Icon name="users" size="xs" />
        </a>
      ) : row.client === null ? null : (
        <Chip icon="users">{row.client}</Chip>
      )}
      {row.category === null ? null : <Chip>{row.category}</Chip>}
      {clearances.map((clearance) => (
        <Chip key={clearance}>
          {clearance}
          <Icon name="document" size="xs" />
        </Chip>
      ))}
    </>
  );
}
