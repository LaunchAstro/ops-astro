// SPDX-License-Identifier: AGPL-3.0-only
//
// The Review workspace's revision bar (C35-X, #2142): which revision is under review, which
// one it is compared with, and each revision's decision as `review.read` tells it: approved,
// by whom, on which digest and whether self-approved in single-operator mode, or undecided.
// A new revision reads undecided. A person holding gate:decide approves the revision under
// review through `review.decide`, naming the digest the screen shows; an agent session, or a
// person without gate:decide, sees no control, and the server refuses them all the same.
//
// One attempt id per approval of one digest, kept until that attempt is answered, so a retry
// after a lost answer approves once. A refusal shows in the server's words with its fix and
// changes nothing else. An answer is drawn only while the screen still answers to the owner
// it was sent for and still shows the digest it named; any other is dropped, reread included.

import { useRef, useState, type ReactElement } from 'react';
import { Banner, Button, Card, Chip } from '@launchastro/ui';
import type {
  CapabilitiesResult,
  ReviewReadResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { isUnavailable, type OperationsClient } from '../../operations/client.ts';
import type { ReadState } from '../../data/authorised-read.ts';
import type { Desk } from '../../data/owned.ts';
import { settle } from '../../records/use-command.ts';
import { short } from './review-geometry.ts';

type Review = ReviewReadResult['review'];
type Revision = Review['revisions'][number];

/** A person, never an agent, holding gate:decide somewhere: the server judges the holder. */
export const holdsGateDecide = (capabilities: ReadState<CapabilitiesResult>): boolean =>
  capabilities.outcome === 'ready' &&
  capabilities.value.agentActorId === undefined &&
  capabilities.value.grants.some((g) => g.collection === 'gate' && g.action === 'decide');

function DecisionOf(props: {
  readonly revision: Revision;
  readonly names: ReadonlyMap<string, string>;
}): ReactElement {
  const { revision } = props;
  const { decision } = revision;
  const by = decision === null ? '' : (props.names.get(decision.decidedByPersonId) ?? 'someone');
  return (
    <li className="spread" data-decision={revision.number}>
      <span>Revision {revision.number}</span>
      {decision === null ? (
        <Chip>Undecided</Chip>
      ) : (
        <>
          <Chip tone="ok">Approved</Chip>
          <span className="t-2">
            by {by},{' '}
            {decision.singleOperatorSelfApproval
              ? 'self-approved in single-operator mode'
              : 'a second person'}
            , on digest {short(decision.digest)}
          </span>
        </>
      )}
    </li>
  );
}

export interface RevisionBarProps {
  readonly client: OperationsClient;
  readonly desk: Desk;
  readonly review: Review;
  readonly names: ReadonlyMap<string, string>;
  readonly mayDecide: boolean;
  readonly reload: () => void;
}

/** The approve control for the revision under review, while it is undecided. */
function Approve(props: RevisionBarProps & { readonly after: Revision }): ReactElement {
  const { client, desk, review, after } = props;
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ readonly digest: string; readonly because: string }>();
  // The digest shown now, read when an answer arrives: one for another is dropped.
  const shown = useRef(after.digest);
  shown.current = after.digest;
  const approve = (): void => {
    if (busy) return;
    const { digest } = after;
    const key = `review.decide:${review.reviewId}`;
    const tag = desk.save();
    const { intents } = desk;
    const operationId = intents.idFor(key, digest);
    setBusy(true);
    setRefused(undefined);
    void (async () => {
      const answer = await client.mutate(
        'review.decide',
        { reviewId: review.reviewId, digest, response: 'approve' },
        { operationId },
      );
      if (!isUnavailable(answer)) intents.answered(key, operationId);
      setBusy(false);
      if (!desk.owns(tag) || shown.current !== digest) return;
      const settlement = settle(answer);
      if (settlement.kind === 'ok') props.reload();
      else setRefused({ digest, because: settlement.because });
    })();
  };
  return (
    <div className="stack" data-approve>
      <div>
        <Button variant="primary" onClick={approve} {...(busy ? { busy: 'Approving…' } : {})}>
          Approve revision {after.number}
        </Button>
      </div>
      {refused?.digest === after.digest ? (
        <div data-approve-refusal>
          <Banner tone="bad" lead="Not approved.">
            {refused.because}
          </Banner>
        </div>
      ) : null}
    </div>
  );
}

export function RevisionBar(props: RevisionBarProps): ReactElement {
  const { review } = props;
  const { after, before } = review;
  return (
    <Card title={review.pageUrl ?? 'A media review'} sub={review.path ?? undefined}>
      <div className="stack" data-revision-bar>
        <div className="spread">
          {review.revisions.map((revision) => (
            <span key={revision.revisionId} data-revision={revision.number}>
              <Chip
                tone={
                  revision.revisionId === after?.revisionId
                    ? 'info'
                    : revision.revisionId === before?.revisionId
                      ? 'idle'
                      : undefined
                }
              >
                Revision {revision.number}
              </Chip>
            </span>
          ))}
        </div>
        <p className="t-2">
          {after === null
            ? 'No revision yet.'
            : before === null
              ? `Revision ${String(after.number)} is the first: there is nothing before it.`
              : `Revision ${String(after.number)} under review, beside revision ${String(before.number)}.`}
        </p>
        <ul className="stack">
          {review.revisions.map((revision) => (
            <DecisionOf key={revision.revisionId} revision={revision} names={props.names} />
          ))}
        </ul>
      </div>
      {after === null || after.decision !== null || !props.mayDecide ? null : (
        <Approve {...props} after={after} />
      )}
    </Card>
  );
}
