// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's command requests (#2011), a member of `CommandRequest` (`requests.ts`), split out so
// that file stays under the per-file size cap. Every operand is checked by value in its handler.

import type { Envelope } from './request-envelope.ts';

export type ReviewRequest =
  | ({
      readonly command: 'review.open';
      readonly taskId: string;
      readonly pageUrl: string;
      readonly path: string;
      /** The site's own revision of the page, which the revision's digest binds. */
      readonly sourceRevision: string;
    } & Envelope)
  | ({ readonly command: 'review.capture'; readonly revisionId: string } & Envelope);
