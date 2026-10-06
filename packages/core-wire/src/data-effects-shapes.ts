// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the effect shapes several commands share, moved whole from
// `data-effects.ts` to keep that file under the per-file line cap.

import type { DataEffects } from './data-effects-types.ts';
import { business, client, writing } from './data-effects-types.ts';

export const READ: DataEffects = writing([]);
// A task is a row of `records`, with its unique values beside it.
export const TASK: DataEffects = writing(client('records', 'record_unique_values'));
// A map or its ticket: the task, and the map's derived summary and frontier.
export const MAP_TASK: DataEffects = writing(
  TASK.writes.concat(client('map_summaries', 'map_frontier')),
);
// A proposal raises the decision's inbox items (INB-1b).
export const PROPOSAL: DataEffects = writing(
  client(
    'evidence_packs',
    'gates',
    'planned_runs',
    'planned_steps',
    'proposal_lineages',
    'proposal_versions',
    // A proposal raises a decision item for each decide holder (INB-1).
    'inbox_items',
  ),
);
export const SETTINGS: DataEffects = writing(business('business_settings'));
export const LEGAL: DataEffects = writing(business('legal_document_versions'));
// A grant names a client only by its scope; it holds no content and admits
// no one, and a party-scoped grant needs a client, which is gated itself.
export const GRANTS: DataEffects = writing(business('grants'));
// A task shared with its client is that client's data reaching the client's existing people: S0-5
// classes it client-data, never an invitation, as it enrols no one (MP-4-10). Taking the share back
// gives no one anything, so `task.revoke_client_share` stays a business grant write.
export const SHARE: DataEffects = writing(client('grants'));
export const CREDENTIAL: DataEffects = writing(business('agent_credentials', 'actors'));
