// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import type { InternalTaskDetail } from '../../../../../packages/core-wire/src/index.ts';
import { encodeBoardAddress } from '../projects/scoped-board.ts';

type BoardTask = Pick<InternalTaskDetail, 'board' | 'key'>;

export function owningBoardAddress(task: BoardTask): string | null {
  if (task.board !== null && !task.board.readable) return null;
  return encodeBoardAddress({
    ...(task.board === null ? { kind: 'unboarded' } : { kind: 'selected', boardId: task.board.id }),
    filters: [],
    focus: null,
    target: task.key,
  });
}

export function PanelBoardDoor(props: { readonly task: BoardTask }): ReactElement {
  const href = owningBoardAddress(props.task);
  return href === null ? (
    <span className="sbact__meta">A board you cannot open</span>
  ) : (
    <a className="btn" data-panel-head="board" href={href}>
      Open its board
    </a>
  );
}
