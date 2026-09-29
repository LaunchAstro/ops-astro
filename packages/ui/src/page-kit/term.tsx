// SPDX-License-Identifier: AGPL-3.0-only
//
// The term tip in the kit's markup (DS-PRIM-18: `term`, `term__tip`), for the
// KPI label and the table header. Page kit only, not exported: the component
// kit's own `Term` takes its place when the kit lands (MP-1-3).

import { useId, type ReactElement, type ReactNode } from 'react';

export function PageTerm(props: {
  readonly definition: string;
  readonly children: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <span className="term term--below" tabIndex={0} aria-describedby={id}>
      {props.children}
      <span className="term__tip" role="tooltip" id={id}>
        {props.definition}
      </span>
    </span>
  );
}
