// SPDX-License-Identifier: AGPL-3.0-only
//
// The three absence voices, and the whole point of this file is that they stay
// three (specification 13.2).
//
// `Empty` says there are no rows. `FieldError` says this input is wrong.
// `InDevelopment` says the product has not built this yet. The legacy Hub
// converges the first and the third onto one empty not-reporting record, and
// the pinned mockup has no idiom at all for the third because it ships
// populated demonstration data. So the third is the one place the slice must be
// more explicit than either source, and it is drawn from the Hub's `.in-dev`
// with its own acceptance rather than as an inherited authority.
//
// Each carries `data-voice`, so a test and a reader can both tell which voice
// is speaking without reading the copy.

import type { ReactElement, ReactNode } from 'react';
import type { AbsenceVoice } from '../state/corpus.ts';

export interface EmptyProps {
  /** What is not here. One line. */
  readonly title: string;
  /** Why, or what would change it. Optional, because not every absence has one. */
  readonly description?: string;
  /** The third tier, for a hint that is not the reason. */
  readonly hint?: string;
  readonly action?: ReactNode;
}

/** Voice one: no rows. */
export function Empty(props: EmptyProps): ReactElement {
  const voice: AbsenceVoice = 'no-rows';
  return (
    <div className="empty" data-voice={voice}>
      <p className="empty__title">{props.title}</p>
      {props.description === undefined ? null : <p className="empty__desc">{props.description}</p>}
      {props.hint === undefined ? null : <p className="empty__hint">{props.hint}</p>}
      {props.action === undefined ? null : <div className="empty__action">{props.action}</div>}
    </div>
  );
}

/**
 * The mockup's own in-pane absence: words and nothing else.
 *
 * It is kept beside `Empty` rather than replaced by it because precedence
 * governs the drawn surface, and on the ported task surfaces the mockup draws
 * `.sbempty` — one paragraph, no icon, no title, no action. Using the tiered
 * `Empty` there would be the port changing an appearance rather than carrying
 * one.
 */
export function PaneEmpty(props: { readonly say: string }): ReactElement {
  const voice: AbsenceVoice = 'no-rows';
  return (
    <p className="sbempty" data-voice={voice}>
      {props.say}
    </p>
  );
}

export interface FieldErrorProps {
  /** The identifier of the control this error belongs to. */
  readonly controlId: string;
  readonly say: string;
}

/**
 * Voice two: this input is wrong.
 *
 * The control itself carries `aria-invalid="true"`; this is its paired text and
 * the pairing is the contract, so the identifier is required rather than
 * optional. An error message with nothing pointing at it is a message a screen
 * reader never reaches.
 */
export function FieldError(props: FieldErrorProps): ReactElement {
  const voice: AbsenceVoice = 'input-wrong';
  return (
    <span className="field__error" id={`${props.controlId}-error`} data-voice={voice}>
      {props.say}
    </span>
  );
}

export interface InDevelopmentProps {
  /** What has not been built. Named, so this is not a shrug. */
  readonly title: string;
  /**
   * Which ticket owns it. Required: an absence with no owner is an absence
   * nobody has agreed to fill, and the whole reason this voice is separate
   * from "no rows" is that it names a fact about the product.
   */
  readonly owner: string;
}

/** Voice three: the product has not built this yet. */
export function InDevelopment(props: InDevelopmentProps): ReactElement {
  const voice: AbsenceVoice = 'not-built';
  return (
    <div className="empty empty--in-dev in-dev" data-voice={voice}>
      <p className="empty__title">{props.title}</p>
      <p className="empty__desc">
        The product has not built this yet. It is not empty and it did not fail.
      </p>
      <p className="empty__hint">Owned by {props.owner}.</p>
    </div>
  );
}
