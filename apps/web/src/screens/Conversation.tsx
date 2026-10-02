// SPDX-License-Identifier: AGPL-3.0-only
//
// C36: `/agent/:conversation`, a conversation at its own address (CS-7.38).
//
// The address reads `conversation.read` with the id it carries and nothing
// else, so it keeps every one of AW-03's refusals: another business's
// conversation answers exactly as a made-up address does, a colleague without
// the read-any grant is refused with the server's reason and shown nothing
// of the conversation, and a client session is refused. After the body
// purges the read carries no messages, so the address draws the wrap-up and
// never a transcript. Navigation only: nothing here writes or audits.

import type { ReactElement } from 'react';
import { ConversationRecord } from '@launchastro/ui';
import type { ConversationReadResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { useRead } from '../data/use-read.ts';
import { RecordState } from '../views/record-state.tsx';

export interface ConversationScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly conversationId: string;
}

export function ConversationScreen(props: ConversationScreenProps): ReactElement {
  const { client, conversationId } = props;
  const { state, reload } = useRead<ConversationReadResult>({
    grantKey: props.grantKey,
    run: () => client.read<ConversationReadResult>('conversation.read', { conversationId }),
    deps: [conversationId],
  });
  return (
    <RecordState state={state} subject="conversation" onRetry={reload}>
      {(value) => (
        <ConversationRecord
          title={value.conversation.title}
          subject={value.conversation.subject}
          messages={value.messages}
          wrapUp={
            value.wrapUp === null
              ? null
              : {
                  request: value.wrapUp.request.quotation,
                  items: value.wrapUp.items,
                  leftOpenText: value.wrapUp.leftOpenText,
                }
          }
        />
      )}
    </RecordState>
  );
}
