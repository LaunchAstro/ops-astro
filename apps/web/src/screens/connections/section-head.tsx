// SPDX-License-Identifier: AGPL-3.0-only
//
// A Connections & signal section's head, as the mockup draws it: a rule with
// the section's number on the left and what it covers on the right, then the
// title. The number and the words are separate, so the title reads alone.

import type { ReactElement, ReactNode } from 'react';

export function SectionHead(props: {
  readonly number: string;
  readonly title: string;
  readonly aside?: ReactNode;
}): ReactElement {
  return (
    <>
      <div className="sec__meta">
        <span className="marker u-tag">{props.number}</span>
        {props.aside === undefined ? null : (
          <span className="marker sec__aside">{props.aside}</span>
        )}
      </div>
      <h2 className="sec__head">{props.title}</h2>
    </>
  );
}
