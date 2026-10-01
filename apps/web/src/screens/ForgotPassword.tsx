// SPDX-License-Identifier: AGPL-3.0-only
//
// `/forgot-password` (C40, piece P3): stub until the page is built.

import type { ReactElement } from 'react';
import type { OpenContext } from '../screen-registry.tsx';

export function ForgotPassword(_props: {
  readonly app: Omit<OpenContext, 'fragment'>;
}): ReactElement {
  return (
    <div className="signin">
      <h2 className="tpr__title">Forgot password</h2>
    </div>
  );
}
