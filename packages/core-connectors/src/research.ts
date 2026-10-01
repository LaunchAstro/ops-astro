// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7's own operation (ORCH47 ruling (b)8): a research run's model call on
// its ticket. The question is the ticket's own title, bound to the run's task
// (S3), so the broker finds its source and a client's or another task's words
// never reach it. Over the replay provider until a real one lands (AW-RP).

import type { ModelOperationDeclaration } from './operation.ts';
import { REPLAY_COMPOSE } from './replay.ts';

export const RESEARCH_COMPOSE: ModelOperationDeclaration = {
  ...REPLAY_COMPOSE,
  key: 'model.research_compose',
  fields: { question: 'business_internal' },
};
