// SPDX-License-Identifier: AGPL-3.0-only
//
// An open request to delete this task (#2351, #2359), and the person's
// answer. An agent asks with `task.request_delete`; the page shows who asked
// and why, with Confirm delete (`task.confirm_delete`, the same delete and
// refusals as Delete task) and Keep (`task.decline_delete`). Both are a
// person's alone: the server refuses either from an agent. Each answer names
// the request on screen (#2362), so it never answers a newer one unseen. A
// refusal is quoted as the server words it; on success the page reads the
// task again.

import type { ReactElement } from 'react';
import { Button, Card } from '@launchastro/ui';
import type { DeleteRequestView } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useCommand } from '../../records/use-command.ts';
import { usePageBusy } from '../../records/page-writes.ts';

export interface DeleteRequestProps {
  readonly client: OperationsClient;
  readonly task: {
    readonly id: string;
    readonly revision: number;
    readonly deleteRequest?: DeleteRequestView | null;
  };
  readonly disabled: boolean;
  readonly onAnswered: () => void;
}

type Answer = 'task.confirm_delete' | 'task.decline_delete';

export function DeleteRequest(props: DeleteRequestProps): ReactElement | null {
  const { busy, because, locked, run } = useCommand();
  const elsewhere = usePageBusy();
  const request = props.task.deleteRequest ?? null;
  if (request === null) return null;
  const answer = (command: Answer): void => {
    run(
      () =>
        props.client.mutate(
          command,
          { recordId: props.task.id, requestId: request.id },
          { expectedRevision: props.task.revision },
        ),
      (settlement) => {
        if (settlement.kind === 'ok') props.onAnswered();
      },
    );
  };
  const lapses = new Date(request.expiresAt).toLocaleDateString('en-AU');
  const who = request.requestedBy === '' ? unnamed(request.byAgent) : request.requestedBy;
  return (
    <div data-delete-request={request.id} role="region" aria-label="Request to delete this task">
      <Card
        title={`${who} asks to delete this task`}
        sub={`${request.reason} Nothing is erased, and a deleted task can be restored. The request lapses on ${lapses}.`}
      >
        <Answers busy={busy} disabled={props.disabled || locked || elsewhere} onAnswer={answer} />
      </Card>
      {because === null ? null : (
        <p className="card__sub" role="alert" data-delete-request-refused>
          {because}
        </p>
      )}
    </div>
  );
}

function unnamed(byAgent: boolean): string {
  return byAgent ? 'An agent' : 'Someone';
}

function Answers(props: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onAnswer: (command: Answer) => void;
}): ReactElement {
  return (
    <>
      <span data-act="confirm-delete">
        <Button
          variant="primary"
          busy={props.busy ? 'Answering…' : undefined}
          disabled={props.disabled}
          onClick={() => props.onAnswer('task.confirm_delete')}
        >
          Confirm delete
        </Button>
      </span>
      <span data-act="keep">
        <Button
          variant="ghost"
          disabled={props.disabled}
          onClick={() => props.onAnswer('task.decline_delete')}
        >
          Keep
        </Button>
      </span>
    </>
  );
}
