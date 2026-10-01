// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7's own operation (ORCH47 ruling (b)8): a research run's model call on
// its ticket. The one field is the question, which the run binds to its own
// ticket's title (S3), so the broker finds the source itself and a client's
// or another task's words never reach the call. Over the replay provider
// until a real one lands (AW-RP); the outside reading a run does goes through
// operations catalogued like this one, never through a key the run holds.

import type { ModelOperationDeclaration } from './operation.ts';
import { REPLAY_COMPOSE } from './replay.ts';

export const RESEARCH_COMPOSE: ModelOperationDeclaration = {
  ...REPLAY_COMPOSE,
  key: 'model.research_compose',
  fields: { question: 'business_internal' },
};
