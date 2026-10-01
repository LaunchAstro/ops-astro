// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the assistant drawer in the dock (DOCK T-16, AI-01 to AI-12).
//
// It decides nothing and stores nothing. The open conversations, the drafted
// question, the page in scope and which models may be offered are the
// application's (`apps/web/src/assistant/`); each control here hands the tab,
// title, model or question to its caller, whose path is the real conversation
// command. The panel label and its accessible name are "Agent" (the U7-SCORE
// finding), and the head keeps the model picker, the eye control and the tab
// strip.
//
// **With no model on offer and a reason in words, the drawer sends nothing**
// (owner line 72): the picker is empty and disabled, the reason sits under the
// head, and a question asked anyway is answered in the drawer, not sent.
import type { ReactElement } from 'react';
import type {
  AssistantChat,
  AssistantMessage,
  AssistantOffer,
  AssistantPanelProps,
} from './assistant/types.ts';
import { Icon } from '../primitives/Icon.tsx';
import { Asker } from './assistant/asker.tsx';
import { TabRow } from './assistant/tab-row.tsx';
import { Transcript } from './assistant/transcript.tsx';

export type {
  AssistantChat,
  AssistantCitation,
  AssistantCite,
  AssistantMessage,
  AssistantModel,
  AssistantOffer,
  AssistantPage,
  AssistantPanelProps,
  AssistantRole,
  AssistantSubjectView,
} from './assistant/types.ts';

const NO_MESSAGES: readonly AssistantMessage[] = [];

function ModelPicker(props: {
  readonly chat: AssistantChat | undefined;
  readonly offer: AssistantOffer;
  readonly onModel: (key: string, model: string) => void;
}): ReactElement {
  const { chat, offer } = props;
  return (
    <select
      className="aip__hmodel"
      data-assistant="model"
      aria-label="Which model you are talking to"
      disabled={offer.models.length === 0 || chat === undefined}
      value={chat?.model ?? offer.models[0]?.id ?? ''}
      onChange={(event) => {
        if (chat !== undefined) props.onModel(chat.key, event.target.value);
      }}
    >
      {offer.models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}
        </option>
      ))}
    </select>
  );
}

function Head(props: {
  readonly chat: AssistantChat | undefined;
  readonly offer: AssistantOffer;
  readonly onModel: (key: string, model: string) => void;
  readonly onAddPage: (key: string) => void;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <header className="aip__head">
      <div className="aip__id">
        <Icon name="sparkles" />
        <span className="aip__title">Agent</span>
        <ModelPicker chat={props.chat} offer={props.offer} onModel={props.onModel} />
      </div>
      <div className="aip__acts">
        <button
          className="aip__act"
          type="button"
          data-assistant="add-page"
          title="Add page to context"
          aria-label="Add page to context"
          onClick={() => {
            if (props.chat !== undefined) props.onAddPage(props.chat.key);
          }}
        >
          <Icon name="eye" size="sm" />
        </button>
        <span className="aip__actdiv" aria-hidden="true" />
        <button
          className="aip__act aip__x"
          type="button"
          data-assistant="close"
          title="Close the panel"
          aria-label="Close the panel"
          onClick={() => {
            props.onClose();
          }}
        >
          <Icon name="cross-small" />
        </button>
      </div>
    </header>
  );
}

/** Where this tab lives (its own address, once started) and what the ask came from. */
function Provenance(props: {
  readonly address: string | null;
  readonly citation: AssistantPanelProps['citation'];
}): ReactElement {
  return (
    <>
      {props.address === null ? null : (
        <a className="aip__address" data-assistant="address" href={props.address}>
          Open at its address
        </a>
      )}
      {props.citation === null ? null : (
        <p className="aip__cited" data-assistant="citation" data-ask-row={props.citation.row}>
          Asked from {props.citation.label}
        </p>
      )}
    </>
  );
}

export function AssistantPanel(props: AssistantPanelProps): ReactElement {
  const chat = props.chats.find((each) => each.key === props.selected);
  const sendable = !(props.offer.models.length === 0 && props.offer.waiting !== null);
  return (
    <section className="aipanel" data-assistant="panel" aria-label="Agent">
      <Head
        chat={chat}
        offer={props.offer}
        onModel={props.onModel}
        onAddPage={props.onAddPage}
        onClose={props.onClose}
      />
      <TabRow
        chats={props.chats}
        selected={props.selected}
        onSelect={props.onSelect}
        onRename={props.onRename}
        onTakeOut={props.onTakeOut}
        onNew={props.onNew}
      />
      {props.offer.waiting === null ? null : (
        <p className="aip__msg aip__msg--note" data-assistant="local-model">
          {props.offer.waiting}
        </p>
      )}
      <Provenance address={props.address ?? null} citation={props.citation} />
      <Transcript messages={chat?.messages ?? NO_MESSAGES} />
      <Asker
        // A new draft, or another tab, starts the field again.
        key={`${props.selected} ${props.citation?.id ?? ''} ${props.draft}`}
        placeholder={props.subject.placeholder}
        subject={props.subject.label}
        chips={props.subject.chips}
        draft={props.draft}
        sendable={sendable}
        onSend={(text) => {
          if (chat !== undefined) props.onSend(chat.key, text);
        }}
      />
    </section>
  );
}
