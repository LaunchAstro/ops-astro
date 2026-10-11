// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import type { StepView } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useCommand } from '../../records/use-command.ts';
import { holding, useHeldOperations } from './held-operations.ts';
import { useSubtaskTrash, type SubtaskTrashReceipt } from './subtask-trash.ts';

const REOPEN_REASON = 'Unticked on the parent task’s subtask list.';
interface SubtaskOwner {
  readonly client: OperationsClient;
  readonly parentId: string;
  readonly grantKey?: string;
  readonly onChanged: () => void;
}

/** Commands settle only into the parent and signed-in client that sent them. */
export function useSubtaskActions(props: SubtaskOwner) {
  const { client } = props;
  const { locked: busy, because, run } = useCommand();
  const current = useSubtaskOwner(client, props.parentId, props.grantKey);
  const trash = useSubtaskTrash(client, props.parentId, props.grantKey);
  const held = useHeldOperations();
  const tick = tickStepAction(props, run, current);
  const remove = (step: StepView): void => {
    const body = { recordId: step.id };
    const hold = holding(held, 'task.trash', { ...body, revision: step.revision }, () =>
      client.newOperationId(),
    );
    run(
      () =>
        client.mutate('task.trash', body, {
          expectedRevision: step.revision,
          operationId: hold.id,
        }),
      (settlement) => {
        hold.settle(settlement.kind);
        if (settlement.kind !== 'ok') return;
        const detail = settlement.value.detail;
        if (typeof detail?.['batchId'] === 'string' && typeof detail['trashed'] === 'number')
          trash.keep({ batchId: detail['batchId'], count: detail['trashed'] });
        if (current()) props.onChanged();
      },
    );
  };
  const restore = (batchId: string): void => {
    const body = { batchId };
    const hold = holding(held, 'task.restore', body, () => client.newOperationId());
    run(
      () => client.mutate('task.restore', body, { operationId: hold.id }),
      (settlement) => {
        hold.settle(settlement.kind);
        if (settlement.kind !== 'ok') return;
        trash.restored(batchId);
        if (current()) props.onChanged();
      },
    );
  };
  return {
    busy,
    because,
    tick,
    remove,
    undo: <TrashUndo receipts={trash.receipts} busy={busy} restore={restore} />,
  };
}

function tickStepAction(
  props: SubtaskOwner,
  run: ReturnType<typeof useCommand>['run'],
  current: () => boolean,
) {
  const { client } = props;
  const tick = (step: StepView): void => {
    run(
      () =>
        step.done
          ? client.mutate(
              'task.reopen',
              { recordId: step.id, reason: REOPEN_REASON },
              { expectedRevision: step.revision },
            )
          : client.mutate(
              'task.complete',
              { recordId: step.id },
              { expectedRevision: step.revision },
            ),
      (settlement) => {
        if (current() && settlement.kind === 'ok') props.onChanged();
      },
    );
  };
  return tick;
}

function TrashUndo(props: {
  readonly receipts: readonly SubtaskTrashReceipt[];
  readonly busy: boolean;
  readonly restore: (batchId: string) => void;
}) {
  return props.receipts.map((receipt) => (
    <p className="card__sub" role="status" data-step-trash key={receipt.batchId}>
      {receipt.count === 1
        ? '1 task moved to the bin.'
        : `${receipt.count} tasks moved to the bin.`}{' '}
      <button
        type="button"
        className="btn btn--ghost"
        data-step-undo
        disabled={props.busy}
        onClick={() => props.restore(receipt.batchId)}
      >
        Undo
      </button>
    </p>
  ));
}

export function useSubtaskOwner(
  client: OperationsClient,
  parentId: string,
  grantKey?: string,
): () => boolean {
  const held = useRef({ client, parentId, grantKey, active: true });
  if (
    held.current.client !== client ||
    held.current.parentId !== parentId ||
    held.current.grantKey !== grantKey
  ) {
    held.current.active = false;
    held.current = { client, parentId, grantKey, active: true };
  }
  const owner = held.current;
  useEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
    };
  }, [owner]);
  return () => owner.active && held.current === owner;
}
