// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat path's task proposal as a card in the chat (designs/chat-path-slice.md,
// piece 2), in the plan card's look. It shows exactly what the click sends:
// the title and the description for a new task, or the changes to the task the
// chat is open on. The one click is "Create task" or "Apply to this task";
// after it the card links the task, or quotes the server's refusal and offers
// the click again; an edit whose task changed since says so and offers none. Nothing is written by the card being drawn, and every word
// on it is text: nothing a model wrote is markup.

import type { ReactElement } from 'react';
import type { AssistantProposal } from './types.ts';

const SEND = { create: 'Create task', edit: 'Apply to this task' } as const;
const KEPT = { create: 'Task created', edit: 'Task updated' } as const;
const HEAD = { create: 'Proposed task', edit: 'Proposed change to this task' } as const;
/** Said until the click lands: a reply's words saying it was done never made it so. */
const PENDING = {
  create: 'Only proposed: no task exists until you click Create task.',
  edit: 'Only proposed: nothing on the task changes until you click Apply to this task.',
} as const;

function Done(props: { readonly proposal: AssistantProposal }): ReactElement | null {
  const { proposal } = props;
  if (proposal.task === null) return null;
  return (
    <div className="aip__plan-done" data-proposal="done">
      <span>{KEPT[proposal.action]}</span>
      <a href={proposal.task.href} data-proposal="task">
        {proposal.task.label}
      </a>
    </div>
  );
}

export function ProposalCard(props: {
  readonly proposal: AssistantProposal;
  readonly onSend: (() => void) | undefined;
}): ReactElement {
  const { proposal, onSend } = props;
  const edit = proposal.action === 'edit';
  return (
    <div className="aip__plan" data-proposal="card" data-action={proposal.action}>
      <span className="aip__plan-k">{HEAD[proposal.action]}</span>
      {proposal.title === null ? null : (
        <p className="aip__plan-words">
          {edit ? <span className="aip__plan-meta">Title: </span> : null}
          <strong data-proposal="title">{proposal.title}</strong>
        </p>
      )}
      {proposal.description === null ? null : (
        <p className="aip__plan-words">
          {edit ? <span className="aip__plan-meta">Description: </span> : null}
          <span data-proposal="description">{proposal.description}</span>
        </p>
      )}
      {proposal.state === 'made' ? null : (
        <p className="aip__plan-meta" data-proposal="pending">
          {PENDING[proposal.action]}
        </p>
      )}
      {proposal.refusal === null ? null : (
        <p className="aip__plan-meta aip__plan-refused" role="alert" data-proposal="refusal">
          {proposal.refusal}
        </p>
      )}
      {proposal.state === 'made' ? (
        <Done proposal={proposal} />
      ) : onSend === undefined || proposal.state === 'stale' ? null : (
        <div className="aip__plan-act">
          <button
            className="btn btn--primary btn--sm"
            type="button"
            data-proposal="send"
            disabled={proposal.state === 'sending'}
            onClick={onSend}
          >
            {proposal.state === 'unknown' ? 'Send again' : SEND[proposal.action]}
          </button>
        </div>
      )}
    </div>
  );
}
