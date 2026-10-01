// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: asking (AI-10 to AI-12), and the sparkle every ask entry wears.
//
// A chip and the input are one path: each hands the question to `onSend` and
// nothing else. **While the subject's material waits on a local model, that
// path sends nothing**: no handler is called, and the drawer says so where the
// person pressed. The question stays in the field, because nothing happened to
// it.

import { useState, type ReactElement } from 'react';

export const NOT_SENT = 'Nothing was sent: this client’s material waits on a local model.';

export interface AskerProps {
  readonly placeholder: string;
  readonly subject: string;
  readonly chips: readonly string[];
  /** The drafted question, if an ask seam drafted one. */
  readonly draft: string;
  /** False while the subject's material may reach no model. */
  readonly sendable: boolean;
  readonly onSend: (text: string) => void;
}

function Chips(props: {
  readonly chips: readonly string[];
  readonly onChip: (chip: string) => void;
}): ReactElement {
  return (
    <div className="aip__chips" role="group" aria-label="Suggested questions">
      {props.chips.map((chip) => (
        <button
          key={chip}
          className="aip__chip"
          type="button"
          onClick={() => {
            props.onChip(chip);
          }}
        >
          {chip}
        </button>
      ))}
    </div>
  );
}

function InputRow(props: {
  readonly placeholder: string;
  readonly subject: string;
  readonly value: string;
  readonly onValue: (value: string) => void;
  readonly onSend: () => void;
}): ReactElement {
  return (
    <div className="aip__inputrow">
      <input
        className="aip__input"
        data-assistant="input"
        aria-label={`Ask the agent about ${props.subject}`}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => {
          props.onValue(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          props.onSend();
        }}
      />
      <button
        className="btn btn--sm btn--primary"
        type="button"
        data-assistant="send"
        onClick={() => {
          props.onSend();
        }}
      >
        Send
      </button>
    </div>
  );
}

export function Asker(props: AskerProps): ReactElement {
  const [value, setValue] = useState(props.draft);
  const [refused, setRefused] = useState(false);
  const send = (text: string, fromInput: boolean): void => {
    const question = text.trim();
    if (question === '') return;
    if (!props.sendable) {
      setRefused(true);
      return;
    }
    props.onSend(question);
    if (fromInput) setValue('');
  };
  return (
    <>
      <Chips
        chips={props.chips}
        onChip={(chip) => {
          send(chip, false);
        }}
      />
      {refused ? (
        <p className="aip__msg aip__msg--note" data-assistant="not-sent" role="status">
          {NOT_SENT}
        </p>
      ) : null}
      <InputRow
        placeholder={props.placeholder}
        subject={props.subject}
        value={value}
        onValue={setValue}
        onSend={() => {
          send(value, true);
        }}
      />
    </>
  );
}

export interface AskSparkleProps {
  /** The register row this entry point is (AG-K7, CL-M03 and the rest). */
  readonly row: string;
  /** The widget, in words: the citation the ask carries. */
  readonly widget: string;
  /**
   * The press, with its shift key. The host opens the drawer through the
   * gesture law (MP-3-4): a plain press solos it, shift stacks it. The sparkle
   * opens nothing itself.
   */
  readonly onAsk: (shift: boolean) => void;
}

export function AskSparkle(props: AskSparkleProps): ReactElement {
  return (
    <button
      className="ask"
      type="button"
      data-ask={props.row}
      aria-label={`Ask the agent about ${props.widget}`}
      title={`Ask the agent about ${props.widget}`}
      onClick={(event) => {
        props.onAsk(event.shiftKey);
      }}
    >
      {/* The icon slot, in words until an icon set with redistribution rights
          is resolved, as the dock's tabs are. */}
      <span aria-hidden="true">Ask</span>
    </button>
  );
}
