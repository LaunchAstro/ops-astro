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
import { useRef, type ReactElement } from 'react';
import type {
  AssistantChat,
  AssistantMessage,
  AssistantOffer,
  AssistantPanelProps,
} from './assistant/types.ts';
import { Icon } from '../primitives/Icon.tsx';
import { Asker } from './assistant/asker.tsx';
import { useHistory } from './assistant/history.tsx';
import { TabRow } from './assistant/tab-row.tsx';
import { Transcript } from './assistant/transcript.tsx';

export type {
  AssistantChat,
  AssistantCitation,
  AssistantCite,
  AssistantHistory,
  AssistantMessage,
  AssistantModel,
  AssistantOffer,
  AssistantPage,
  AssistantPanelProps,
  AssistantPast,
  AssistantPlan,
  AssistantRole,
  AssistantSubjectView,
  PlanCardState,
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

/** The drawer's own close, after a divider, when it stands alone. */
function Close(props: { readonly onClose: () => void }): ReactElement {
  return (
    <>
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
    </>
  );
}

function Head(props: {
  readonly chat: AssistantChat | undefined;
  readonly offer: AssistantOffer;
  readonly onModel: (key: string, model: string) => void;
  readonly onAddPage: (key: string) => void;
  readonly onClose: (() => void) | undefined;
  /** The history control, beside Page, where the caller offers a history. */
  readonly history: ReactElement | null;
}): ReactElement {
  const { onClose } = props;
  // In a host's frame (the dock's `ai` panel) the host's head names the drawer
  // and closes it, so this row keeps only the model picker and Page.
  const Row = onClose === undefined ? 'div' : 'header';
  return (
    <Row className="aip__head">
      <div className="aip__id">
        {onClose === undefined ? null : (
          <>
            <Icon name="sparkles" />
            <span className="aip__title">Agent</span>
          </>
        )}
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
        {props.history}
        {onClose === undefined ? null : <Close onClose={onClose} />}
      </div>
    </Row>
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

/**
 * Each tab's sends still in flight, kept here because the field is drawn anew
 * for each tab: back on a tab, a chip is not sent again while that tab's last
 * send is out, as the field itself refuses while it stays drawn.
 */
function useChipGuard(
  chips: readonly string[],
  onSend: AssistantPanelProps['onSend'],
): AssistantPanelProps['onSend'] {
  const out = useRef(new Map<string, number>());
  return (key, text) => {
    const sending = out.current.get(key) ?? 0;
    if (sending > 0 && chips.includes(text)) return;
    out.current.set(key, sending + 1);
    const sent = onSend(key, text);
    // The field hears a failure from `sent` itself; this branch only counts.
    const landed = (): void => {
      out.current.set(key, (out.current.get(key) ?? 1) - 1);
    };
    void Promise.resolve(sent).then(landed, landed);
    return sent;
  };
}

/** The selected tab's transcript, and that it is answering while a question is out. */
function Thread(props: {
  readonly chat: AssistantChat | undefined;
  readonly answering: boolean;
  readonly onAccept: AssistantPanelProps['onAccept'];
}): ReactElement {
  const { chat, onAccept } = props;
  return (
    <>
      <Transcript
        messages={chat?.messages ?? NO_MESSAGES}
        onAccept={
          onAccept === undefined || chat === undefined
            ? undefined
            : (messageId) => onAccept(chat.key, messageId)
        }
      />
      {props.answering ? (
        <p className="aip__msg aip__msg--note" role="status" data-assistant="answering">
          Answering…
        </p>
      ) : null}
    </>
  );
}

export function AssistantPanel(props: AssistantPanelProps): ReactElement {
  const chat = props.chats.find((each) => each.key === props.selected);
  const sendable = !(props.offer.models.length === 0 && props.offer.waiting !== null);
  const send = useChipGuard(props.subject.chips, props.onSend);
  const history = useHistory(props.history);
  return (
    <section className="aipanel" data-assistant="panel" aria-label="Agent">
      <Head
        chat={chat}
        offer={props.offer}
        onModel={props.onModel}
        onAddPage={props.onAddPage}
        onClose={props.onClose}
        history={history.control}
      />
      <TabRow
        chats={props.chats}
        selected={props.selected}
        onSelect={props.onSelect}
        onRename={props.onRename}
        onTakeOut={props.onTakeOut}
        onNew={props.onNew}
      />
      {history.list}
      {props.offer.waiting === null ? null : (
        <p className="aip__msg aip__msg--note" data-assistant="local-model">
          {props.offer.waiting}
        </p>
      )}
      <Provenance address={props.address ?? null} citation={props.citation} />
      {props.allowance}
      <Thread chat={chat} answering={props.answering === true} onAccept={props.onAccept} />
      <Asker
        // A new draft, or another tab, starts the field again.
        key={`${props.selected} ${props.citation?.id ?? ''} ${props.draft}`}
        placeholder={props.subject.placeholder}
        subject={props.subject.label}
        chips={props.subject.chips}
        draft={props.draft}
        sendable={sendable}
        onSend={(text) => (chat === undefined ? undefined : send(chat.key, text))}
      />
    </section>
  );
}
