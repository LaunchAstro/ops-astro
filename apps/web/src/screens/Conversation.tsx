// SPDX-License-Identifier: AGPL-3.0-only
//
// C36: `/agent/:conversation`. Declared shape only.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../operations/client.ts';

export interface ConversationScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly conversationId: string;
}

export function ConversationScreen(_props: ConversationScreenProps): ReactElement {
  return <section />;
}
