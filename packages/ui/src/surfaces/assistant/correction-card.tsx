// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the sidebar chat's one-word site correction, drawn as a card under the
// line that asked for it (the owner check's first step).
//
// The card says what was asked and where it stands: the page, the word, its
// replacement, the line before and after, and the approval state in words
// (waiting for the configured approver, approved, refused). It decides
// nothing: the request went through `live_correction.request` and the decision
// is the configured approver's, never the requester's. Whether its values are
// made up is the transcript's to mark (`provenance` on the line), with the
// kit's one mock mark, so the card carries no mark of its own. Every value is
// text: nothing a person or a page wrote is read as markup.

import type { ReactElement } from 'react';
import { Button } from '../../kit/controls.tsx';
import { StatusMark, type MarkTone } from '../../kit/marks.tsx';

export type AssistantCorrectionState = 'waiting' | 'approved' | 'refused';

export interface AssistantCorrection {
  /** The page of the site, as the person named it ("About"). */
  readonly page: string;
  readonly word: string;
  readonly replacement: string;
  /** The line the word sits in, as it reads now, and as it will read. */
  readonly before: string;
  readonly after: string;
  readonly state: AssistantCorrectionState;
  /** Who decides, by name where known; otherwise the configured approver. */
  readonly approver: string | null;
  /** Whether the decision can be read again from here. */
  readonly checkable: boolean;
}

const STATES = {
  waiting: { tone: 'info', words: 'Waiting for' },
  approved: { tone: 'ok', words: 'Approved by' },
  refused: { tone: 'bad', words: 'Refused by' },
} as const satisfies Record<AssistantCorrectionState, { tone: MarkTone; words: string }>;

const isLetter = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}'’-]/u.test(char);

/** Where `word` stands as a whole word in `line`, or -1. */
export function wordAt(line: string, word: string): number {
  if (word === '') return -1;
  let from = line.indexOf(word);
  while (from !== -1) {
    if (!isLetter(line[from - 1]) && !isLetter(line[from + word.length])) return from;
    from = line.indexOf(word, from + 1);
  }
  return -1;
}

/** The line with its word marked: struck before, inserted after. */
function Line(props: {
  readonly name: 'before' | 'after';
  readonly line: string;
  readonly word: string;
}): ReactElement {
  const at = wordAt(props.line, props.word);
  const Mark = props.name === 'before' ? 'del' : 'ins';
  return (
    <p className="aip__fixline" data-correction-field={props.name}>
      <span className="aip__fixk">{props.name === 'before' ? 'Before' : 'After'}</span>
      {at === -1 ? (
        props.line
      ) : (
        <>
          {props.line.slice(0, at)}
          <Mark>{props.word}</Mark>
          {props.line.slice(at + props.word.length)}
        </>
      )}
    </p>
  );
}

export function CorrectionCard(props: {
  readonly correction: AssistantCorrection;
  readonly onCheck?: (() => void) | undefined;
}): ReactElement {
  const { correction, onCheck } = props;
  const state = STATES[correction.state];
  const approver = correction.approver ?? 'the configured approver';
  return (
    <section
      className="aip__fix"
      data-correction={correction.state}
      aria-label={`One-word change on the ${correction.page} page`}
    >
      <div className="aip__fixhead">
        <span className="aip__fixtitle">One-word change</span>
        <span data-correction-state="">
          <StatusMark tone={state.tone} look="text">{`${state.words} ${approver}`}</StatusMark>
        </span>
      </div>
      <dl className="aip__fixfacts">
        <dt>Page</dt>
        <dd data-correction-field="page">{correction.page}</dd>
        <dt>Word</dt>
        <dd data-correction-field="word">{correction.word}</dd>
        <dt>Becomes</dt>
        <dd data-correction-field="replacement">{correction.replacement}</dd>
      </dl>
      <Line name="before" line={correction.before} word={correction.word} />
      <Line name="after" line={correction.after} word={correction.replacement} />
      {correction.state === 'waiting' && correction.checkable && onCheck !== undefined ? (
        <span data-correction-check="">
          <Button variant="ghost" onClick={onCheck}>
            Check again
          </Button>
        </span>
      ) : null}
    </section>
  );
}
