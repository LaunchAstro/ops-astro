// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's live correction rows, spread into `COMMAND_SURFACE` in `surface.ts`
// (kept apart for the line cap). Each is asked at the correction's party
// (`prepare.ts`, TARGET_LOOKUPS; the read inside its query), so one client's
// grant reaches no other client's correction. The request is `run:write`, an
// agent's inside its delegation; the read asks the request's own `run:write`
// (ORCH33); the approval, the review and the revert ask `gate:decide`, never an
// agent's, and only of the configured approver who is not the requester.

import type { CommandDeclaration } from './surface-declaration.ts';
import { declare, read } from './surface-builders.ts';
import {
  DECIDE_AT_CORRECTION,
  REVERT_AT_CORRECTION,
  REVIEW_AT_CORRECTION,
} from './surface-live-correction.ts';

const RUN_COLLECTION = 'run';
const SETTINGS_COLLECTION = 'settings';
const OPERATIONS_COLLECTION = 'operations';

export const SITE_SURFACE: readonly CommandDeclaration[] = [
  read('live_correction.read', RUN_COLLECTION, { action: 'write' }),
  read('live_correction.list', RUN_COLLECTION, { action: 'write' }),
  read('live_correction.receipts', RUN_COLLECTION, { action: 'write' }),
  declare('live_correction.request', 'write', {
    collection: RUN_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['taskId'],
    agent: 'delegated',
  }),
  declare('live_correction.decide', 'decide', DECIDE_AT_CORRECTION),
  declare('live_correction.revert', 'decide', REVERT_AT_CORRECTION),
  declare('live_correction.record_review', 'decide', REVIEW_AT_CORRECTION),
  // #2316: a client's site and pages, bound under `operations:manage` on that
  // client (`prepare.ts`), never an agent's (`site-bind-write.ts`).
  declare('client.bind_site', 'manage', {
    collection: OPERATIONS_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['clientId'],
  }),
  declare('settings.set_live_correction_approver', 'manage', {
    collection: SETTINGS_COLLECTION,
    targetsExistingRecord: false,
    untargetedIdentifiers: [],
  }),
];
