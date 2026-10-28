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
      /** The live correction this revision captures the published page of (#2120). */
      readonly correctionId?: unknown;
    } & Envelope)
  | ({ readonly command: 'review.capture'; readonly revisionId: string } & Envelope)
  | ({
      readonly command: 'review.capture_claim';
      readonly leaseId: string;
      readonly fence: number;
      readonly revisionId: string;
    } & Envelope)
  | ({
      readonly command: 'review.capture_land';
      readonly leaseId: string;
      readonly fence: number;
      readonly revisionId: string;
      readonly width: number;
      /** The picture's bytes, base64. */
      readonly picture: string;
      readonly observation: Readonly<Record<string, unknown>>;
    } & Envelope)
  | ({
      readonly command: 'review.carry_pins';
      readonly leaseId: string;
      readonly fence: number;
      readonly revisionId: string;
    } & Envelope)
  | ({
      readonly command: 'review.pin_comment';
      readonly revisionId: string;
      /** The capture's width: 1480 or 390. */
      readonly width: unknown;
      /** The Web Annotation selectors that find the spot on that capture. */
      readonly selector: unknown;
      readonly body: string;
      readonly audience: string;
      /** The live view's width when the pin was made on it (#2120); absent for a capture pin. */
      readonly liveViewport?: unknown;
    } & Envelope)
  | ({
      readonly command: 'review.propose_change';
      /** The client pin filed: a comment on the review's task. */
      readonly commentId: string;
      /** The change asked for, in the filing person's words. */
      readonly text: unknown;
    } & Envelope)
  | ({
      readonly command: 'review.decide_change';
      readonly changeRequestId: string;
      /** approve or refuse. */
      readonly decision: unknown;
    } & Envelope)
  | ({
      readonly command: 'review.make_change_task';
      /** The worker's live lease on the review's task, and the fence it holds. */
      readonly leaseId: unknown;
      readonly fence: unknown;
      readonly changeRequestId: unknown;
    } & Envelope)
  | ({
      readonly command: 'review.decide';
      readonly reviewId: unknown;
      /** The digest of the review's latest revision, as `review.read` shows it. */
      readonly digest: unknown;
      readonly response: unknown;
    } & Envelope)
  | ({
      readonly command: 'review.record_astra_review';
      readonly reviewId: unknown;
      readonly digest: unknown;
      readonly verdict: unknown;
      /** Astra's saved review, kept with the digest it read. */
      readonly review: unknown;
    } & Envelope);
