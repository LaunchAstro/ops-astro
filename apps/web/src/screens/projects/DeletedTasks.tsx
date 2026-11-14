// SPDX-License-Identifier: AGPL-3.0-only
//
// The Tasks page's Deleted tab (#2346): the deleted tasks the reader may
// restore, over `task.bin`, each with Restore through `task.restore` and the
// row's batch. A person who cannot delete is refused the read, and the tab
// says so with the server's words and draws no row.
//
// One Restore press is one intent: its operation id is minted once per batch
// and reused if the answer is lost and the person presses again, so the
// server restores once (`held-operations.ts`). The page mounts this under the
// reader's grant key, so a switch of business or person starts it afresh.

import { useRef, type ReactElement } from 'react';
import { Button, Table } from '@launchastro/ui';
import type { TaskBinResult, TaskBinRow } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useRead } from '../../data/use-read.ts';
import { useCommand } from '../../records/use-command.ts';
import { RecordState } from '../../views/record-state.tsx';
import { holding, type Held } from '../task/held-operations.ts';

const WHEN = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeStyle: 'short' });

const COLUMNS = [
  { key: 'task', label: 'Task' },
  { key: 'deleted', label: 'Deleted' },
  { key: 'by', label: 'By' },
  { key: 'restore', label: '' },
] as const;

export interface DeletedTasksProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
}

export function DeletedTasks(props: DeletedTasksProps): ReactElement {
  const { client, grantKey } = props;
  const read = useRead<TaskBinResult>({
    grantKey,
    run: () => client.read<TaskBinResult>('task.bin', {}),
    isEmpty: (value) => value.bin.length === 0,
    deps: [client],
  });
  const { locked, because, run } = useCommand();
  const held = useRef<Held>({});
  const restore = (row: TaskBinRow): void => {
    const body = { batchId: row.batchId };
    const hold = holding(held.current, 'task.restore', body, () => client.newOperationId());
    run(
      () => client.mutate('task.restore', body, { operationId: hold.id }),
      (settlement) => {
        hold.settle(settlement.kind);
        if (settlement.kind === 'ok') read.reload();
      },
    );
  };
  return (
    <div className="stack" data-deleted-tasks>
      {because === null ? null : (
        <p className="card__sub" role="alert" data-restore-refused>
          {because}
        </p>
      )}
      <RecordState
        state={read.state}
        subject="deleted tasks"
        onRetry={read.reload}
        keep
        empty={<p className="card__sub">No deleted tasks.</p>}
      >
        {(loaded) => (
          <>
            <Table
              caption="Deleted tasks"
              columns={COLUMNS}
              rows={loaded.bin.map((row) => rowOf(row, locked, restore))}
              dense
            />
            {loaded.more ? <p className="card__sub">Older deleted tasks are not shown.</p> : null}
          </>
        )}
      </RecordState>
    </div>
  );
}

function rowOf(
  row: TaskBinRow,
  locked: boolean,
  restore: (row: TaskBinRow) => void,
): Readonly<Record<string, ReactElement | string>> {
  return {
    task: (
      <span data-bin-task={row.taskId}>
        {row.key === '' ? row.title : `${row.key} ${row.title}`}
      </span>
    ),
    deleted: <time dateTime={row.deletedAt}>{WHEN.format(new Date(row.deletedAt))}</time>,
    by: row.deletedBy,
    restore: (
      <span data-act="restore">
        <Button variant="ghost" disabled={locked} onClick={() => restore(row)}>
          Restore
        </Button>
      </span>
    ),
  };
}
