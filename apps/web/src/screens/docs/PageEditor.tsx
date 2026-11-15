// SPDX-License-Identifier: AGPL-3.0-only
//
// Editing one Docs page (#2515, piece 4b; round DECISIONS 129): its Markdown in a plain
// textarea, the rendered preview beside it (the task brief's renderer: nothing the text says
// becomes markup), Save and Cancel. Save sends docs.update_page with the version the page was
// opened at; a page that moved on in between is refused, shown as "changed since you opened
// it", and the draft stays so nothing typed is lost and nothing is overwritten.

import { useState, type ReactElement } from 'react';
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

export function PageEditor(props: {
  readonly pageId: string;
  /** The version the page was opened at: the one a save is checked against. */
  readonly version: number;
  readonly body: string;
  readonly send: DocsSend;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { pageId, version, send } = props;
  const [draft, setDraft] = useState(props.body);
  const [words, setWords] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const answer = await send(`save:${pageId}`, 'docs.update_page', {
      pageId,
      expectedVersion: version,
      body: draft,
    });
    setBusy(false);
    if (answer.kind === 'done') props.onSaved();
    if (answer.kind === 'refused') setWords(answer.words);
  };
  return (
    <div className="stack" data-docs-editor="">
      <DraftAndPreview pageId={pageId} draft={draft} onType={setDraft} />
      <SendRow
        words={words}
        busy={busy}
        label="Save"
        act="save"
        onSend={() => void save()}
        onCancel={props.onCancel}
      />
    </div>
  );
}
