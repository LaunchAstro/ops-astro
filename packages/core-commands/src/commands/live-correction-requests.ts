// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's command requests, a member of `CommandRequest` (`requests.ts`), split
// out so that file stays under the per-file size cap.

import type { Envelope } from './request-envelope.ts';

// The request carries the one file's text before and after, which the
// handler checks against the envelope before anything is written, and keeps
// only as digests; the approval names the exact version the caller read.
export type LiveCorrectionRequest =
  | ({
      readonly command: 'live_correction.request';
      readonly partyId: string;
      readonly taskId: string;
      readonly path: string;
      readonly word: string;
      readonly replacement: string;
      readonly pageUrl: string;
      readonly baseRevision: string;
      readonly before: string;
      readonly after: string;
    } & Envelope)
  | ({
      readonly command: 'live_correction.decide';
      readonly correctionId: string;
      readonly versionId: string;
      readonly decision: string;
    } & Envelope)
  | ({
      readonly command: 'settings.set_live_correction_approver';
      /** A member's person id, or null to leave no one configured. */
      readonly value: string | null;
      readonly expectedRevision?: number;
    } & Envelope);
