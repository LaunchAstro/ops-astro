// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried deployment's answers (live chat route B): typed and inert until built.

import type { ConversationExchange } from '../../packages/core-commands/src/index.ts';
import type { CarriedSettings } from './model-carrier.ts';

type Settings = Readonly<Record<string, string | undefined>>;

export function carriedAnswers(
  _environment: Settings,
  _carried: CarriedSettings,
): { readonly answerConversation: ConversationExchange } {
  throw new Error('carried answers are not built');
}
