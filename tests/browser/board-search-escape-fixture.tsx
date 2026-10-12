// SPDX-License-Identifier: AGPL-3.0-only
// Proofs from the independent review of #1408 (round 1), retitled by what they prove; their bodies are as written.
/* eslint-disable unicorn/prefer-query-selector -- the review's proof, kept as written */
import { createRoot } from 'react-dom/client';
import { BoardSearch } from '../../packages/ui/src/surfaces/BoardSearch.tsx';

const root = document.getElementById('root');
if (root === null) throw new Error('missing proof root');
createRoot(root).render(
  <>
    <BoardSearch
      facets={[]}
      names={['Zebra Zed']}
      noun="task"
      have={{ ids: [], text: [] }}
      onCommit={(raw) => {
        document.querySelector('output')?.replaceChildren(raw);
      }}
      onTake={() => {}}
      onDropLast={() => {}}
    />
    <output />
  </>,
);
