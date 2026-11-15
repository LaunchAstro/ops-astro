// SPDX-License-Identifier: AGPL-3.0-only
//
// The business's Docs (#2493 piece 2): the folder tree on the left from `docs.tree`, and the
// chosen page drawn read-only on the right from `docs.page`. Both are `docs:read` on the
// business, so a reader without it sees the plain refusal, never an empty tree. The page's
// Markdown is drawn by the task brief's renderer: nothing the text says becomes markup. The
// two columns sit inside the read state, which wraps what it draws, so the grid is its child.
//
// Piece 4b (#2515): a session whose `session.capabilities` list `docs:write` also sees Edit and
// Move on the page, New folder and New document above the tree, and Rename and Move beside each
// folder (`docs/PageEditor.tsx`, `docs/DocsActs.tsx`); the server still asks `docs:write` on
// every write. After an answer the tree and the page are read again. Everything held for one
// business and sign-in, a draft included, is keyed to them, so a switch starts the screen anew.

import { useState, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type {
  CapabilitiesResult,
  DocsTreeResult,
} from '../../../../packages/core-wire/src/index.ts';
import type { ReadState } from '../data/authorised-read.ts';
import { useRead } from '../data/use-read.ts';
import type { RollupFloor } from '../data/rollup-floor.ts';
import type { OperationsClient } from '../operations/client.ts';
import { RecordState } from '../views/record-state.tsx';
import { DocsActForm, type DocsAct } from './docs/DocsActs.tsx';
import { DocsPage } from './docs/DocsPage.tsx';
import { DocsTree, type Writing } from './docs/DocsTree.tsx';
import { useDocsWrite } from './docs/docs-write.ts';

/** Whether the session holds `docs:write`, as `session.capabilities` answers it. */
const holdsDocsWrite = (state: ReadState<CapabilitiesResult>): boolean =>
  state.outcome === 'ready' &&
  state.value.grants.some((grant) => grant.collection === 'docs' && grant.action === 'write');

interface DocsProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly rollup: RollupFloor;
}

/** The tree, whether this session may write, the open act, and a count of answered changes. */
function useDocsScreen(props: DocsProps) {
  const { client, grantKey } = props;
  const [act, setAct] = useState<DocsAct | null>(null);
  const [changes, setChanges] = useState(0);
  const send = useDocsWrite(client, grantKey);
  const capabilities = useRead<CapabilitiesResult>({
    grantKey,
    run: () => client.read<CapabilitiesResult>('session.capabilities', {}),
    deps: [client],
  });
  const tree = useRead<DocsTreeResult>({
    grantKey,
    run: () => client.read<DocsTreeResult>('docs.tree', {}),
    deps: [client],
    rollup: props.rollup,
    isEmpty: (value) => value.folders.length === 0,
  });
  const writing: Writing | null = holdsDocsWrite(capabilities.state)
    ? { send, open: setAct }
    : null;
  const changed = () => {
    tree.reload();
    setChanges((n) => n + 1);
  };
  return { act, setAct, changes, changed, tree, writing };
}

/** The open act's form; a done act closes and the screen reads again. */
function ActPanel(props: {
  readonly act: DocsAct;
  readonly writing: Writing;
  readonly state: ReadState<DocsTreeResult>;
  readonly setAct: (act: DocsAct | null) => void;
  readonly changed: () => void;
}): ReactElement {
  const { act, state, setAct } = props;
  return (
    <DocsActForm
      key={JSON.stringify(act)}
      act={act}
      folders={state.outcome === 'ready' ? state.value.folders : []}
      send={props.writing.send}
      onDone={() => {
        setAct(null);
        props.changed();
      }}
      onCancel={() => setAct(null)}
    />
  );
}

const EMPTY_TREE: DocsTreeResult = { ok: true, folders: [], pages: [] };

/** The screen for one business and sign-in: its tree, its page, and what it may write. */
function DocsFor(props: DocsProps): ReactElement {
  const [chosen, setChosen] = useState<string | null>(null);
  const { act, setAct, changes, changed, tree, writing } = useDocsScreen(props);
  const { state, reload } = tree;
  return (
    <section className="stack" aria-label="Docs">
      {writing === null || act === null ? null : (
        <ActPanel act={act} writing={writing} state={state} setAct={setAct} changed={changed} />
      )}
      {writing !== null && state.outcome === 'empty' ? (
        <DocsTree tree={EMPTY_TREE} chosen={null} onChoose={setChosen} writing={writing} />
      ) : null}
      <RecordState
        state={state}
        subject="docs"
        onRetry={reload}
        empty={
          <Empty
            title="No docs yet."
            description="Folders and pages your team files appear here."
          />
        }
      >
        {(value) => (
          <div className="docs">
            <DocsTree tree={value} chosen={chosen} onChoose={setChosen} writing={writing} />
            <div className="docs__page">
              {chosen === null ? (
                <Empty title="Choose a page." description="Pick a page in a folder to read it." />
              ) : (
                <DocsPage
                  key={`${chosen}:${String(changes)}`}
                  {...props}
                  pageId={chosen}
                  writing={writing}
                  onChanged={changed}
                />
              )}
            </div>
          </div>
        )}
      </RecordState>
    </section>
  );
}

export function DocsScreen(props: DocsProps): ReactElement {
  // A business or person switch starts the screen anew: no draft, act or choice carries over.
  return <DocsFor key={`${props.client.businessKey}:${props.grantKey}`} {...props} />;
}
