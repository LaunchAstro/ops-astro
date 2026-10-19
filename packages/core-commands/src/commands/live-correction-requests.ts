// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's command requests, a member of `CommandRequest` (`requests.ts`), split
// out so that file stays under the per-file size cap.

import type { Envelope } from './request-envelope.ts';

// The request names the task, the page as the person typed it and the two
// words, nothing else (#1693): the server resolves the page of the task's own
// site, and the site runner pins the version from the file itself, so no
// caller supplies a revision, a file or a digest. The approval names the exact
// version the caller read.
export type LiveCorrectionRequest =
  | ({
      readonly command: 'live_correction.request';
      readonly taskId: string;
      readonly page: string;
      readonly word: string;
      readonly replacement: string;
    } & Envelope)
  | ({
      readonly command: 'live_correction.decide';
      readonly correctionId: string;
      readonly versionId: string;
      readonly decision: string;
    } & Envelope)
  // The configured approver's one ask that a live correction be reverted.
  | ({ readonly command: 'live_correction.revert'; readonly correctionId: string } & Envelope)
  | ({
      readonly command: 'settings.set_live_correction_approver';
      /** A member's person id, or null to leave no one configured. */
      readonly value: string | null;
      readonly expectedRevision?: number;
    } & Envelope);
