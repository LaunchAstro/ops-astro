// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's Delete (#2345), confirmed first. It sends `task.delete`
// against the page's revision; on success the page reads the task again and
// finds it gone. A refusal (money, run or client history, or no authority)
// is quoted as the server words it. It waits while any other write on the
// page is in flight (`page-writes.ts`).

import { useState, type ReactElement } from 'react';
import { Button, Card } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import { useCommand } from '../../records/use-command.ts';
import { usePageBusy } from '../../records/page-writes.ts';

export interface DeleteTaskProps {
  readonly client: OperationsClient;
  readonly task: { readonly id: string; readonly revision: number };
  readonly disabled: boolean;
  readonly onDeleted: () => void;
}

export function DeleteTask(props: DeleteTaskProps): ReactElement {
  const { busy, because, locked, run } = useCommand();
  const elsewhere = usePageBusy();
  const [confirming, setConfirming] = useState(false);
  const remove = (): void => {
    setConfirming(false);
    run(
      () =>
        props.client.mutate(
          'task.delete',
          { recordId: props.task.id },
          { expectedRevision: props.task.revision },
        ),
      (settlement) => {
        if (settlement.kind === 'ok') props.onDeleted();
      },
    );
  };
  return (
    <section className="sb__sect" data-task-delete>
      {confirming ? (
        <ConfirmDelete
          held={props.disabled || elsewhere}
          onDelete={remove}
          onKeep={() => setConfirming(false)}
        />
      ) : (
        <span data-act="ask-delete">
          <Button
            variant="ghost"
            busy={busy ? 'Deleting…' : undefined}
            disabled={props.disabled || locked || elsewhere}
            onClick={() => setConfirming(true)}
          >
            Delete task
          </Button>
        </span>
      )}
      {because === null ? null : (
        <p className="card__sub" role="alert" data-task-delete-refused>
          {because}
        </p>
      )}
    </section>
  );
}

function ConfirmDelete(props: {
  readonly held: boolean;
  readonly onDelete: () => void;
  readonly onKeep: () => void;
}): ReactElement {
  return (
    <div data-confirm="delete-task">
      <Card
        title="Delete this task?"
        sub="It and its subtasks disappear from every list. Nothing is erased, and it can be restored."
      >
        <span data-act="delete">
          <Button variant="primary" disabled={props.held} onClick={props.onDelete}>
            Delete task
          </Button>
        </span>
        <span data-act="keep">
          <Button variant="ghost" onClick={props.onKeep}>
            Keep it
          </Button>
        </span>
      </Card>
    </div>
  );
}
