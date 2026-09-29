// SPDX-License-Identifier: AGPL-3.0-only
//
// The conversation commands' request shapes (AW-03, MP-7-11), a part of
// `CommandRequest` kept beside it so `requests.ts` stays under the per-file
// cap. Every field is `unknown` because the handlers check each one.

import type { Envelope } from './request-envelope.ts';

export type ConversationRequest =
  | ({
      readonly command: 'conversation.start';
      readonly body: unknown;
      readonly title?: unknown;
      readonly subject?: unknown;
      readonly scope?: unknown;
    } & Envelope)
  | ({
      readonly command: 'conversation.message';
      readonly conversationId: unknown;
      readonly body: unknown;
    } & Envelope)
  | ({
      readonly command: 'conversation.rename';
      readonly conversationId: unknown;
      readonly title: unknown;
    } & Envelope)
  | ({
      readonly command: 'conversation.set_scope';
      readonly conversationId: unknown;
      readonly page: unknown;
    } & Envelope);
