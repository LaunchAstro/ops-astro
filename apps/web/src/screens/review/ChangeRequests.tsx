// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 part C (#2119, spec #2085): the change-request panel on the review's task. It lists the
// review's change requests as `review.read` answers them, each in its phase (`change-requests.ts`),
// with approve and refuse on a proposed one for a reader holding `proposal:decide`; the server
// decides again on every press (`review-change.ts`), so the hidden controls are a courtesy, never
// the check. A client pin with no request yet takes a person's own words through the same
// `review.propose_change` an agent is refused. Drawn from the shared kit alone, no style of its
// own. A reader the server refused sees why in its words and nothing of the requests.

import { Banner, Button, Empty, StatusMark, TextField } from '@launchastro/ui';
import { useState, type ReactElement } from 'react';
import {
  AGENT_WAIT,
  PHASE_LABEL,
  PHASE_TONE,
  phaseOf,
  unfiledClientPins,
  type ChangeRequestView,
  type DockLoad,
  type LocalModelCode,
  type PinView,
} from './change-requests.ts';
import { useChangeRequests, type DockClient } from './use-change-requests.ts';

export interface ChangeRequestPanelProps {
  readonly load: DockLoad;
  readonly canDecide: boolean;
  /** The request or pin a write is out for: its controls hold until it is answered. */
  readonly busy: string | null;
  /** The last write's refusal in the server's words, or the local-model wait. */
  readonly note: string | null;
  /** Why the agent's filing waits: either code reads as the one wait. */
  readonly agent: LocalModelCode;
  readonly onDecide: (changeRequestId: string, decision: 'approve' | 'refuse') => void;
  readonly onFile: (commentId: string, text: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  /** Read the review again after a read that got no answer. */
  readonly onReadAgain: () => void;
}

const TITLE = 'Change requests';

/** Approve and refuse on a proposed request; the decision rides on the kit-classed button. */
function Decide(props: {
  readonly request: ChangeRequestView;
  readonly panel: ChangeRequestPanelProps;
}): ReactElement {
  const { request, panel } = props;
  return (
    <div className="btnrow">
      {(['refuse', 'approve'] as const).map((decision) => (
        <button
          key={decision}
          type="button"
          className={`btn btn--sm btn--${decision === 'approve' ? 'primary' : 'secondary'}`}
          data-decide={decision}
          disabled={panel.busy !== null}
          aria-busy={panel.busy === request.changeRequestId ? true : undefined}
          onClick={() => {
            panel.onDecide(request.changeRequestId, decision);
          }}
        >
          {decision === 'approve' ? 'Approve' : 'Refuse'}
        </button>
      ))}
    </div>
  );
}

function Request(props: {
  readonly request: ChangeRequestView;
  readonly panel: ChangeRequestPanelProps;
}): ReactElement {
  const { request, panel } = props;
  const phase = phaseOf(request);
  const made = phase === 'made' ? request.createdTaskId : null;
  return (
    <div
      className="stack"
      role="listitem"
      data-change-request={request.changeRequestId}
      data-phase={phase}
    >
      <StatusMark look="line" tone={PHASE_TONE[phase]}>
        {PHASE_LABEL[phase]}
      </StatusMark>
      <p className="card__sub">{request.text}</p>
      {phase === 'pending' ? (
        <p className="card__sub" role="status">
          A worker makes it a task under its lease; nothing is done yet.
        </p>
      ) : null}
      {made === null ? null : (
        <>
          <p className="card__sub">Made task {made}</p>
          <div className="btnrow" data-made-task={made}>
            <Button
              variant="text"
              onClick={() => {
                panel.onOpenTask(made);
              }}
            >
              Open the task it was made
            </Button>
          </div>
        </>
      )}
      {phase === 'proposed' && panel.canDecide ? <Decide request={request} panel={panel} /> : null}
    </div>
  );
}

function FilePin(props: {
  readonly pin: PinView;
  readonly panel: ChangeRequestPanelProps;
}): ReactElement {
  const [text, setText] = useState('');
  const { pin, panel } = props;
  const words = text.trim();
  return (
    <div className="stack" role="listitem" data-file-pin={pin.commentId}>
      <p className="card__sub">The client pinned: {pin.body}</p>
      <TextField
        label="The change, in your words"
        multiline
        value={text}
        onChange={setText}
        disabled={panel.busy === pin.commentId}
      />
      <div className="btnrow">
        <Button
          disabled={words === '' || (panel.busy !== null && panel.busy !== pin.commentId)}
          busy={panel.busy === pin.commentId ? 'Filing…' : undefined}
          onClick={() => {
            if (words !== '') panel.onFile(pin.commentId, words);
          }}
        >
          File as a change request
        </Button>
      </div>
    </div>
  );
}

/** The review's requests, the agent path's wait and the client pins a person may still file. */
function Ready(props: {
  readonly load: Extract<DockLoad, { kind: 'ready' }>;
  readonly panel: ChangeRequestPanelProps;
}): ReactElement {
  const { load, panel } = props;
  return (
    <>
      {panel.note === null ? null : (
        <Banner tone="warn" lead="Not done:">
          {panel.note}
        </Banner>
      )}
      {load.requests.length === 0 ? (
        <Empty look="inline" title="No change requests on this review yet" />
      ) : (
        <div className="stack" role="list">
          {load.requests.map((request) => (
            <Request key={request.changeRequestId} request={request} panel={panel} />
          ))}
        </div>
      )}
      <div data-agent-path={panel.agent}>
        <Banner tone="info" lead="Agent filing:">
          {AGENT_WAIT}
        </Banner>
      </div>
      <div className="stack" role="list">
        {unfiledClientPins(load.pins, load.requests).map((pin) => (
          <FilePin key={pin.commentId} pin={pin} panel={panel} />
        ))}
      </div>
    </>
  );
}

/** A read that got no answer: the server could not be reached, which is no refusal. */
function NoAnswer(props: {
  readonly because: string;
  readonly onReadAgain: () => void;
}): ReactElement {
  return (
    <Banner tone="warn" lead="No answer from the server:">
      {props.because}{' '}
      <button
        type="button"
        className="btn btn--sm btn--secondary"
        data-read-again
        onClick={props.onReadAgain}
      >
        Read again
      </button>
    </Banner>
  );
}

export function ChangeRequestPanel(props: ChangeRequestPanelProps): ReactElement {
  const { load } = props;
  return (
    <section className="card" data-change-requests={load.kind} aria-label={TITLE}>
      <header className="card__head">
        <h3 className="card__title">{TITLE}</h3>
      </header>
      <div className="card__body stack">
        {load.kind === 'loading' ? (
          <p className="card__sub" role="status">
            Reading the review’s change requests…
          </p>
        ) : load.kind === 'unavailable' ? (
          <NoAnswer because={load.because} onReadAgain={props.onReadAgain} />
        ) : load.kind === 'refused' ? (
          <Empty
            look="inline"
            title="These change requests are not yours to read"
            description={load.because}
          />
        ) : (
          <Ready load={load} panel={props} />
        )}
      </div>
    </section>
  );
}

/** The panel over its own reads and writes, for the review `reviewId` names. */
export function ChangeRequestDock(props: {
  readonly client: DockClient;
  readonly reviewId: string;
  readonly onOpenTask: (taskId: string) => void;
}): ReactElement {
  const model = useChangeRequests(props.client, props.reviewId);
  return (
    <ChangeRequestPanel
      load={model.load}
      canDecide={model.canDecide}
      busy={model.busy}
      note={model.note}
      agent="CLIENT_MODEL_USE_OFF"
      onDecide={model.decide}
      onFile={model.file}
      onOpenTask={props.onOpenTask}
      onReadAgain={model.readAgain}
    />
  );
}
