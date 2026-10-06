// SPDX-License-Identifier: AGPL-3.0-only
//
// CS-7.30: the models the drawer's picker offers, read from
// `conversation.models` for the selected tab's conversation (none before its
// first question: the install's own models). The server's offer is the
// authority: it filters by the conversation's client's model-egress setting,
// and `conversation.set_model` and the exchange ask the same rule again. An
// answer is kept with the client and conversation it was read for, so another
// tab's models are never drawn here; a refused or unavailable read offers
// nothing.

import { useEffect, useState } from 'react';
import type { ConversationModelsResult } from '../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../operations/client.ts';
import type { ModelChoice } from './subject.ts';

interface Held {
  readonly client: OperationsClient;
  readonly conversationId: string | null;
  readonly models: readonly ModelChoice[];
}

const NONE: readonly ModelChoice[] = [];

export function useModels(
  client: OperationsClient,
  conversationId: string | null,
): readonly ModelChoice[] {
  const [held, setHeld] = useState<Held | null>(null);
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const body = conversationId === null ? {} : { conversationId };
      const answer = await client.read<ConversationModelsResult>('conversation.models', body);
      if (!current) return;
      // A refused, unavailable or malformed answer offers nothing.
      const offered = isRefusal(answer) || isUnavailable(answer) ? undefined : answer.value.models;
      const models = Array.isArray(offered)
        ? offered.map((model) => ({ id: model.id, label: model.id }))
        : NONE;
      setHeld({ client, conversationId, models });
    };
    void load();
    return () => {
      current = false;
    };
  }, [client, conversationId]);
  return held?.client === client && held.conversationId === conversationId ? held.models : NONE;
}
