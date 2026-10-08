// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's conversation (MP-4-5 in MP-4-8): the task's comments,
// opening on the tab the reply door was pressed from. Its draft, open edit and
// refusal are the panel's own, held above its read (`useConversationHeld`), so
// a reread keeps them, one that failed and was tried again included.

import { useState, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';
import { Comments, type CommentDraft } from './Comments.tsx';
import type { ConversationTab } from './Perspectives.tsx';
import type { RowEdit } from './Thread.tsx';

/** The conversation's draft, open edit and refusal, opening on the tab the reply door was pressed from. */
export function useConversationHeld(tab: ConversationTab | null) {
  const [draft, setDraft] = useState<CommentDraft | null>(
    tab === null ? null : { body: '', tab, replyTo: null, pending: null, stale: null },
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  const [editing, setEditing] = useState<RowEdit | null>(null);
  return { draft, setDraft, refusal, setRefusal, editing, setEditing };
}

interface PanelConversationProps {
  readonly grantKey?: string | undefined;
  readonly client: OperationsClient;
  readonly task: Task;
  readonly held: ReturnType<typeof useConversationHeld>;
  readonly onChanged: () => void;
}

/** The conversation, with what the panel holds for it. */
export function PanelConversation(props: PanelConversationProps): ReactElement {
  const { task, held } = props;
  return (
    <Comments
      {...(props.grantKey === undefined ? {} : { grantKey: props.grantKey })}
      scope="panel"
      client={props.client}
      comments={task.comments}
      recordId={task.id}
      revision={task.revision}
      refusal={held.refusal}
      onRefused={held.setRefusal}
      onPosted={props.onChanged}
      draft={held.draft}
      onDraft={held.setDraft}
      editing={held.editing}
      onEditing={held.setEditing}
    />
  );
}
