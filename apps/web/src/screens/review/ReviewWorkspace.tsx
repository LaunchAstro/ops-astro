// SPDX-License-Identifier: AGPL-3.0-only
//
// The Review workspace (C35, #2105; CS-15.1): one review read through `review.read`. The
// revision bar says which revision is under review and which one it is compared with; each
// width, laptop and phone, shows the revision before beside the one under review with the
// pins drawn on each, and what changed between their landed observations; the pin list
// numbers every pin as the panes do. Pins carried onto the revision under review (#2140) draw
// there by their carried anchor; a lost one draws nowhere under review and sits first in the
// list, flagged and still open, and a carry still to come says so. A first revision shows no
// before. A click on a landed capture of the revision under review marks a spot, and the form
// beneath pins a comment on it. Capture again under the revision bar asks the revision's
// captures, or opens the next revision and asks its own (`CaptureAgain.tsx`). The live view of
// the bound page stands beside each capture under review, and the review's change requests sit
// under the pin list. The read is the team's, so the client
// never reaches this page; what a client sees of a pin is the task's client projection.

import { useState, type Dispatch, type ReactElement, type SetStateAction } from 'react';
import { Card, Chip, Empty, ListRow, SectionHead, sectionIndex } from '@launchastro/ui';
import type {
  ReviewReadResult,
  WidthDifference,
} from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useRead } from '../../data/use-read.ts';
import type { RollupFloor } from '../../data/rollup-floor.ts';
import { pathTo } from '../../routes.ts';
import type { TaskPanelHost } from '../task/panel-host.ts';
import { RecordState } from '../../views/record-state.tsx';
import { LiveFrame } from '../projects/review-live-frame.tsx';
import { CaptureAgain } from './CaptureAgain.tsx';
import { CapturePane } from './CapturePane.tsx';
import { ChangeRequestDock } from './ChangeRequests.tsx';
import { PinForm } from './PinForm.tsx';
import { drawnPins, PinList, type Numbered } from './PinList.tsx';
import type { Spot } from './review-geometry.ts';

type Review = ReviewReadResult['review'];
type Revision = NonNullable<Review['after']>;

const WIDTHS = [
  { width: 1480, name: 'Laptop' },
  { width: 390, name: 'Phone' },
] as const;

const short = (digest: string | null): string =>
  digest === null ? 'none' : digest.replace(/^sha256:/u, '').slice(0, 12);

function RevisionBar(props: { readonly review: Review }): ReactElement {
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
      </div>
    </Card>
  );
}

function Changed(props: {
  readonly difference: WidthDifference | undefined;
  readonly first: boolean;
}): ReactElement {
  const { difference } = props;
  if (difference === undefined) {
    return (
      <Empty
        title="Nothing to compare yet"
        description={
          props.first
            ? 'A first revision has nothing before it.'
            : 'This width compares once it has landed on both revisions.'
        }
        look="row"
      />
    );
  }
  return (
    <div className="stack" data-difference={difference.width}>
      {difference.text === null ? (
        <p className="t-2">The text did not change.</p>
      ) : (
        <p data-text-change={difference.text.at}>
          <del>{difference.text.removed}</del> <ins>{difference.text.added}</ins>
        </p>
      )}
      {difference.stylesheets.length === 0 ? (
        <p className="t-2">No stylesheet changed.</p>
      ) : (
        <ul className="stack">
          {difference.stylesheets.map((sheet) => (
            <ListRow
              key={sheet.address}
              look="record"
              title={sheet.address}
              meta={`${short(sheet.before)} to ${short(sheet.after)}`}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A marked spot, held to the revision it was marked on so a re-read never moves it. */
interface Marked {
  readonly revisionId: string;
  readonly width: number;
  readonly spot: Spot;
}

/** The spot marked at this width on this revision, if any. */
const markedOn = (marked: Marked | null, revision: Revision, width: number): Spot | null =>
  marked?.revisionId === revision.revisionId && marked.width === width ? marked.spot : null;

interface WorkspaceProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly review: Review;
  readonly reload: () => void;
  readonly onOpenTask: (taskId: string) => void;
}

type WidthProps = WorkspaceProps & {
  readonly order: number;
  readonly width: number;
  readonly name: string;
  /** Each pin by its number, and each pin found again by its carried anchor too. */
  readonly drawn: Numbered;
  readonly marked: Marked | null;
  readonly mark: Dispatch<SetStateAction<Marked | null>>;
};

/** The revision before beside the one under review, at one width; only the latter takes a spot. */
function Panes(props: WidthProps & { readonly after: Revision }): ReactElement {
  const { review, width } = props;
  const pane = (revision: Revision, when: string, takesSpot: boolean) => (
    <CapturePane
      client={props.client}
      grantKey={props.grantKey}
      title={`${when}, revision ${String(revision.number)}`}
      width={width}
      capture={revision.captures.find((each) => each.width === width)}
      pins={props.drawn.filter(
        ([, pin]) => pin.anchor.source === revision.revisionId && pin.anchor.width === width,
      )}
      marked={takesSpot ? markedOn(props.marked, revision, width) : null}
      {...(takesSpot
        ? {
            onSpot: (spot: Spot) => props.mark({ revisionId: revision.revisionId, width, spot }),
          }
        : {})}
    />
  );
  // The revision under review stands beside the page as it is now.
  const underReview =
    review.pageUrl === null ? (
      pane(props.after, 'Under review', true)
    ) : (
      <LiveFrame
        pageUrl={review.pageUrl}
        loadKey={props.after.revisionId}
        capture={pane(props.after, 'Under review', true)}
      />
    );
  return review.before === null ? (
    underReview
  ) : (
    <div className="statrow statrow--2">
      {pane(review.before, 'Before', false)}
      {underReview}
    </div>
  );
}

function AtWidth(props: WidthProps): ReactElement {
  const { review, width } = props;
  const after = review.after;
  const spot = after === null ? null : markedOn(props.marked, after, width);
  return (
    <section className="stack" data-review-width={width}>
      <SectionHead
        index={sectionIndex(props.order)}
        title={`${props.name}, ${String(width)} wide`}
      />
      {after === null ? null : <Panes {...props} after={after} />}
      {after === null || spot === null ? null : (
        <PinForm
          client={props.client}
          revisionId={after.revisionId}
          width={width}
          spot={spot}
          onPinned={(pinned) => {
            // Only this pin's own spot: the person may have moved on to another one.
            props.mark((now) => (now?.spot === pinned ? null : now));
            props.reload();
          }}
          onCancel={() => {
            props.mark(null);
          }}
        />
      )}
      <Card title="What changed">
        <Changed
          difference={review.differences.find((each) => each.width === width)}
          first={review.before === null}
        />
      </Card>
    </section>
  );
}

function Workspace(props: WorkspaceProps): ReactElement {
  const [marked, mark] = useState<Marked | null>(null);
  const numbered = props.review.pins.map((pin, at) => [at + 1, pin] as const);
  const drawn = drawnPins(props.review, numbered);
  return (
    <>
      <RevisionBar review={props.review} />
      <CaptureAgain client={props.client} review={props.review} onAsked={props.reload} />
      {WIDTHS.map(({ width, name }, at) => (
        <AtWidth
          key={width}
          {...props}
          order={at + 1}
          width={width}
          name={name}
          drawn={drawn}
          marked={marked}
          mark={mark}
        />
      ))}
      <PinList review={props.review} numbered={numbered} />
      <ChangeRequestDock
        client={props.client}
        reviewId={props.review.reviewId}
        onOpenTask={props.onOpenTask}
        changes={props.review}
      />
    </>
  );
}

export function ReviewWorkspaceScreen(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly reviewId: string;
  /** No topic reaches a review, so it re-reads on the tab's floor: a revoked grant clears it. */
  readonly rollup?: RollupFloor;
  /** Goes to an address inside the application. */
  readonly navigate: (path: string) => void;
  /** The app's task door: a made change request's task opens there, else on its page. */
  readonly taskPanel?: Pick<TaskPanelHost, 'open'>;
}): ReactElement {
  const read = useRead<ReviewReadResult>({
    grantKey: props.grantKey,
    run: async () =>
      await props.client.read<ReviewReadResult>('review.read', { reviewId: props.reviewId }),
    deps: [props.client, props.reviewId],
    ...(props.rollup === undefined ? {} : { rollup: props.rollup }),
  });
  return (
    <div className="secs" data-screen="review-workspace">
      <RecordState state={read.state} subject="review" onRetry={read.reload} keep>
        {(answer) => (
          <Workspace
            client={props.client}
            grantKey={props.grantKey}
            review={answer.review}
            reload={read.reload}
            onOpenTask={(taskId) => {
              if (props.taskPanel === undefined) {
                props.navigate(pathTo('agency:task-detail', { key: taskId }));
              } else props.taskPanel.open(taskId, 'open');
            }}
          />
        )}
      </RecordState>
    </div>
  );
}
