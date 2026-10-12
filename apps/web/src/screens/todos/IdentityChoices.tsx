// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import type { Chip } from './todo-list.ts';
export function IdentityChoices(props: {
  readonly filters: readonly Chip[];
  readonly onChoose: (next: readonly Chip[]) => void;
}): ReactElement {
  return (
    <>
      {props.filters.map((chip, index) =>
        chip.kind === 'unresolved' ? (
          <div key={index} role="status">
            {chip.reason}
            {chip.choices.map((choice) => (
              <button
                key={`${choice.kind}:${choice.value}`}
                type="button"
                className="btn"
                data-todos-identity={choice.value}
                onClick={() =>
                  props.onChoose(props.filters.map((each, at) => (at === index ? choice : each)))
                }
              >
                {choice.kind}: {choice.name} ({choice.value})
              </button>
            ))}
          </div>
        ) : null,
      )}
    </>
  );
}
