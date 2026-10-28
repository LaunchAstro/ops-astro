// SPDX-License-Identifier: AGPL-3.0-only
//
// The workspace's Capture again (C35, PROTO-GAPS row 4). A revision under review with no
// capture asked asks its own at both widths (`review.capture`). One asked already cannot be
// asked again (CAPTURE_ALREADY_ASKED), so the press opens the next revision of the review's own
// task, page and file (`review.open`, the page as published now) and asks that one's. Each
// press is one intent on the revision it was made on: its open and its capture each keep one
// attempt id until answered, so a retry after a lost answer opens and asks once. The server's
// refusal is shown in its own words; once asked, the workspace reads the review again.

import { useRef, type ReactElement } from 'react';
import { Button } from '@launchastro/ui';
import type { ReviewReadResult } from '../../../../../packages/core-wire/src/index.ts';
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type OperationsClient,
} from '../../operations/client.ts';
import type { CommandOutcome } from '../../operations/results.ts';
import { useCommand } from '../../records/use-command.ts';
import { LIVE_SOURCE } from '../task/OpenReview.tsx';

type Review = ReviewReadResult['review'];
type Revision = NonNullable<Review['after']>;

/** One press's attempt ids: the next revision's open, then its capture. */
interface Attempt {
  readonly open: string;
  readonly capture: string;
}

interface CaptureAgainProps {
  readonly client: OperationsClient;
  readonly review: Review;
  readonly onAsked: () => void;
}

/** The next revision of the review's own page opened, then its capture asked. */
async function openThenAsk(
  { client, review }: CaptureAgainProps,
  attempt: Attempt,
  capture: (revisionId: string) => Promise<CallResult<CommandOutcome>>,
): Promise<CallResult<CommandOutcome>> {
  const opened = await client.mutate(
    'review.open',
    {
      taskId: review.taskId,
      pageUrl: review.pageUrl,
      path: review.path,
      sourceRevision: LIVE_SOURCE,
    },
    { operationId: attempt.open },
  );
  if (isRefusal(opened) || isUnavailable(opened)) return opened;
  const revisionId = opened.value.detail?.['revisionId'];
  return typeof revisionId === 'string' ? await capture(revisionId) : opened;
}

/** One press on the revision under review, its attempt ids kept until answered. */
function useCaptureAgain(props: CaptureAgainProps, after: Revision) {
  const { busy, because, run } = useCommand();
  const held = useRef(new Map<string, Attempt>());
  const asked = after.captures.length > 0;
  const press = (): void => {
    const intent = after.revisionId;
    const attempt = held.current.get(intent) ?? {
      open: props.client.newOperationId(),
      capture: props.client.newOperationId(),
    };
    held.current.set(intent, attempt);
    const capture = (revisionId: string) =>
      props.client.mutate('review.capture', { revisionId }, { operationId: attempt.capture });
    run(
      async () => {
        const answer = asked
          ? await openThenAsk(props, attempt, capture)
          : await capture(after.revisionId);
        if (!isUnavailable(answer)) held.current.delete(intent);
        return answer;
      },
      (settlement) => {
        if (settlement.kind === 'ok') props.onAsked();
      },
    );
  };
  return { asked, busy, because, press };
}

export function CaptureAgain(props: CaptureAgainProps): ReactElement | null {
  const { after, pageUrl, path } = props.review;
  if (after === null || pageUrl === null || path === null) return null;
  return <Press {...props} after={after} />;
}

function Press(props: CaptureAgainProps & { readonly after: Revision }): ReactElement {
  const { asked, busy, because, press } = useCaptureAgain(props, props.after);
  return (
    <div className="spread" data-capture-again>
      <Button variant="secondary" onClick={press} {...(busy ? { busy: 'Asking…' } : {})}>
        {asked ? 'Capture again' : 'Capture this revision'}
      </Button>
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </div>
  );
}
