// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { Icon } from '../primitives/Icon.tsx';

export function ChipRemove(props: {
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly onRemove: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="chip__x"
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onRemove}
    >
      <Icon name="cross-small" size="xs" />
    </button>
  );
}
