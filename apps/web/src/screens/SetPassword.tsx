// SPDX-License-Identifier: AGPL-3.0-only
//
// `/reset` (C40, piece P3): stub until the page is built.

import type { ReactElement } from 'react';
import type { OpenContext } from '../screen-registry.tsx';

export function SetPassword(_props: {
  readonly fragment: string;
  readonly app: Omit<OpenContext, 'fragment'>;
}): ReactElement {
  return (
    <div className="signin">
      <h2 className="tpr__title">Set a new password</h2>
    </div>
  );
}
