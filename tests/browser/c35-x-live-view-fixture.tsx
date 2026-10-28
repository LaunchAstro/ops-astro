// SPDX-License-Identifier: AGPL-3.0-only
//
// The live view on its own, as the review workspace (#2105) will place it: the
// page to frame, whether a capture exists, and an optional same-origin sibling
// frame come from the address; two buttons switch the revision and unmount.

import { useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveFrame } from '../../apps/web/src/screens/projects/review-live-frame.tsx';

const query = new URLSearchParams(location.search);
const page = query.get('page') ?? '';
const sibling = query.get('sibling');
const capture =
  query.get('capture') === '0' ? null : (
    <img alt="Capture at 1480" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
  );

function Proof(): ReactElement {
  const [revision, setRevision] = useState(1);
  const [shown, setShown] = useState(true);
  return (
    <>
      <button type="button" data-next-revision="" onClick={() => setRevision((n) => n + 1)}>
        Next revision
      </button>
      <button type="button" data-previous-revision="" onClick={() => setRevision((n) => n - 1)}>
        Previous revision
      </button>
      <button type="button" data-unmount="" onClick={() => setShown(false)}>
        Unmount
      </button>
      {shown ? (
        <LiveFrame pageUrl={page} loadKey={`revision-${revision}`} capture={capture} />
      ) : null}
      {sibling === null ? null : <iframe title="Sibling" data-sibling="" src={sibling} />}
    </>
  );
}

const root = document.querySelector('#root');
if (root === null) throw new Error('missing proof root');
createRoot(root).render(<Proof />);
