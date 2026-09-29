// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the drawer on the real conversation commands (declared shape).

import { useState, type ReactElement } from 'react';
import { AssistantPanel } from '@launchastro/ui';
import { initial } from '../assistant/chats.ts';
import { subjectFor } from '../assistant/subject.ts';
import type { AskEntry } from '../assistant/chats.ts';
import type { OperationsClient } from '../operations/client.ts';
import type { RouteId } from '../routes.ts';

export interface AssistantViewProps {
  readonly client: OperationsClient;
  readonly route: RouteId;
  readonly here: string;
  readonly entry: AskEntry | null;
  readonly onClose: () => void;
}

const inert = (): void => {};

export function AssistantView(props: AssistantViewProps): ReactElement {
  const [state] = useState(initial);
  const subject = subjectFor({ route: props.route, client: null, task: null });
  return (
    <AssistantPanel
      subject={subject}
      chats={state.chats}
      selected={state.selected}
      offer={{ models: [], waiting: null }}
      citation={null}
      draft=""
      onSelect={inert}
      onRename={inert}
      onTakeOut={inert}
      onNew={inert}
      onModel={inert}
      onAddPage={inert}
      onSend={inert}
      onClose={props.onClose}
    />
  );
}
