// SPDX-License-Identifier: AGPL-3.0-only
//
// Editing one Docs page (#2515, piece 4b; round DECISIONS 129): its Markdown in a plain
// textarea, the rendered preview beside it (the task brief's renderer: nothing the text says
// becomes markup), Save and Cancel. Save sends docs.update_page with the version the page was
// opened at; a page that moved on in between is refused, shown as "changed since you opened
// it", and the draft stays so nothing typed is lost and nothing is overwritten.
//
// The draft lives with the screen (`Draft`, held by `Docs.tsx`), not in this editor: a routine
// re-read redraws the page and this editor with it, and the words come back as they were
// (S2527-1). A save closes the editor only when nothing was typed while it was in flight; words
// typed meanwhile stay, and the next save starts from the version that save made (S2527-2).

import { useState, type Dispatch, type ReactElement, type SetStateAction } from 'react';
import { Markdown } from '../task/Markdown.tsx';
import type { DocsSend } from './docs-write.ts';

/** The draft and its preview, side by side on a desktop. */
function DraftAndPreview(props: {
  readonly pageId: string;
  readonly draft: string;
  readonly onType: (draft: string) => void;
}): ReactElement {
  const { pageId, draft } = props;
  return (
    <div className="docs__edit">
      <div className="field">
        <label className="tf__k" htmlFor={`docs-draft-${pageId}`}>
          Markdown
        </label>
        <textarea
          id={`docs-draft-${pageId}`}
          className="input docs__draft"
          data-docs-draft=""
          value={draft}
          onChange={(event) => props.onType(event.target.value)}
        />
      </div>
      <div className="card" data-docs-preview="" aria-label="Preview">
        <Markdown source={draft} />
      </div>
    </div>
  );
}

/** The server's words for the last refused press, Save and Cancel. */
export function SendRow(props: {
  readonly words: string | null;
  readonly busy: boolean;
  readonly label: string;
  readonly act: 'save' | 'send';
  readonly onSend: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  return (
    <>
      {props.words === null ? null : (
        <p className="field__error" role="alert" data-docs-refusal="">
          {props.words}
        </p>
      )}
      <div className="row">
        <button
          className="btn btn--primary"
          type="button"
          data-docs-act={props.act}
          disabled={props.busy}
          onClick={props.onSend}
        >
          {props.busy ? 'Sending…' : props.label}
        </button>
        <button className="btn" type="button" data-docs-act="cancel" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

/** The page being edited: the version it was opened at, the words so far, a refusal's words. */
export interface Draft {
  readonly pageId: string;
  readonly version: number;
  readonly text: string;
  readonly words: string | null;
}

/** The screen's draft and its setter, which outlive every re-read of the page. */
export interface Drafting {
  readonly draft: Draft | null;
  readonly set: Dispatch<SetStateAction<Draft | null>>;
}

/** After a save of `sent`: closed when the draft still says it, else kept on the version made. */
function afterSave(current: Draft | null, sent: Draft, version: unknown): Draft | null {
  if (current?.pageId !== sent.pageId) return current;
  if (current.text === sent.text) return null;
  return typeof version === 'number' ? { ...current, version, words: null } : current;
}

export function PageEditor(props: {
  readonly draft: Draft;
  readonly set: Drafting['set'];
  readonly send: DocsSend;
  readonly onSaved: () => void;
}): ReactElement {
  const { draft, set, send } = props;
  const { pageId } = draft;
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const answer = await send(`save:${pageId}`, 'docs.update_page', {
      pageId,
      expectedVersion: draft.version,
      body: draft.text,
    });
    setBusy(false);
    if (answer.kind === 'done') {
      set((current) => afterSave(current, draft, answer.detail['version']));
      props.onSaved();
    }
    if (answer.kind === 'refused') {
      const { words } = answer;
      set((current) => (current?.pageId === pageId ? { ...current, words } : current));
    }
  };
  return (
    <div className="stack" data-docs-editor="">
      <DraftAndPreview
        pageId={pageId}
        draft={draft.text}
        onType={(text) => set((current) => (current === null ? null : { ...current, text }))}
      />
      <SendRow
        words={draft.words}
        busy={busy}
        label="Save"
        act="save"
        onSend={() => void save()}
        onCancel={() => set(null)}
      />
    </div>
  );
}
