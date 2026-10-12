// SPDX-License-Identifier: AGPL-3.0-only
//
// One labelled select of the new-task draft, with a first option for none.

import { StyledSelect } from '@launchastro/ui';
import type { ReactElement } from 'react';

export interface Choice {
  readonly id: string;
  readonly title: string;
}

export function Select(props: {
  readonly id: string;
  readonly label: string;
  readonly locked: boolean;
  readonly value: string | null;
  readonly choices: readonly Choice[];
  readonly none?: string;
  readonly onChoose: (value: string | null) => void;
  readonly onFocus?: () => void;
}): ReactElement {
  return (
    <div className="field">
      <label className="tf__k" htmlFor={props.id}>
        {props.label}
      </label>
      <StyledSelect
        id={props.id}
        className="input"
        disabled={props.locked}
        value={props.value ?? ''}
        onFocus={props.onFocus}
        onChange={(event) => {
          props.onChoose(event.target.value === '' ? null : event.target.value);
        }}
      >
        <option value="">{props.none ?? 'Not set'}</option>
        {props.choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.title}
          </option>
        ))}
      </StyledSelect>
    </div>
  );
}
