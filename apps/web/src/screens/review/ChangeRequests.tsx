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
        ) : load.kind === 'refused' ? (
          <Empty
            look="inline"
            title="These change requests are not yours to read"
            description={load.because}
          />
        ) : (
          <>
            {props.note === null ? null : (
              <Banner tone="warn" lead="Not done:">
                {props.note}
              </Banner>
            )}
            {load.requests.length === 0 ? (
              <Empty look="inline" title="No change requests on this review yet" />
            ) : (
              <div className="stack" role="list">
                {load.requests.map((request) => (
                  <Request key={request.changeRequestId} request={request} panel={props} />
                ))}
              </div>
            )}
            <div data-agent-path={props.agent}>
              <Banner tone="info" lead="Agent filing:">
                {AGENT_WAIT}
              </Banner>
            </div>
            <div className="stack" role="list">
              {unfiledClientPins(load.pins, load.requests).map((pin) => (
                <FilePin key={pin.commentId} pin={pin} panel={props} />
              ))}
            </div>
          </>
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
  /** The host's own read of the review, when it has one: a new one reads the panel again. */
  readonly changes?: unknown;
}): ReactElement {
  const model = useChangeRequests(props.client, props.reviewId, props.changes);
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
    />
  );
}
