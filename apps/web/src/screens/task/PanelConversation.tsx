// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's conversation (MP-4-5 in MP-4-8): the task's comments,
// opening on the tab the reply door was pressed from. Its draft, open edit and
// refusal are the panel's own, so a re-read of the task keeps them.

import { useState, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { InternalTaskDetail as Task } from '../../../../../packages/core-wire/src/index.ts';
import { Comments, type CommentDraft } from './Comments.tsx';
import type { ConversationTab } from './Perspectives.tsx';
import type { RowEdit } from './Thread.tsx';

interface PanelConversationProps {
  readonly client: OperationsClient;
  readonly task: Task;
  /** The tab the reply door was pressed from, or null for the conversation's own. */
  readonly tab: ConversationTab | null;
  readonly onChanged: () => void;
}

/** The conversation, opening on the tab the reply door was pressed from. */
export function PanelConversation(props: PanelConversationProps): ReactElement {
  const { task, tab } = props;
  const [draft, setDraft] = useState<CommentDraft | null>(
    tab === null ? null : { body: '', tab, replyTo: null, pending: null, stale: null },
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  const [editing, setEditing] = useState<RowEdit | null>(null);
  return (
    <Comments
      scope="panel"
      client={props.client}
      comments={task.comments}
      recordId={task.id}
      revision={task.revision}
      refusal={refusal}
      onRefused={setRefusal}
      onPosted={props.onChanged}
      draft={draft}
      onDraft={setDraft}
      editing={editing}
      onEditing={setEditing}
    />
  );
}
