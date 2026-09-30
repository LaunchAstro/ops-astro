// SPDX-License-Identifier: AGPL-3.0-only
//
// `/legal/<business>/<document>/`: one of a business's published legal
// documents (C81, CS-16.20), read with no sign-in from the public read
// (`${PUBLIC_PREFIX}<business>/legal/<document>`) and never through the
// session's client, so no bearer goes with it.
//
// The API answers a missing business, an unpublished version, the breach
// runbook and a name that is no document with one 404, and the page draws
// them as one "not published" state that says nothing about which it was.
// The body is drawn as text paragraphs, split on blank lines, never as markup.

import { useEffect, useState, type ReactElement } from 'react';
import { Card, Empty } from '@launchastro/ui';
import { pathTo } from '../routes.ts';
import { PUBLIC_PREFIX } from '../../../../packages/core-wire/src/index.ts';

/** The public documents, in the order sign-in lists them, and their titles. */
export const PUBLIC_DOCUMENTS = [
  ['privacy-policy', 'Privacy policy'],
  ['client-terms', 'Client terms'],
  ['data-handling', 'Data handling'],
] as const;

interface Published {
  readonly version: string;
  readonly body: string;
  readonly publishedAt: string;
}

type Answer = 'reading' | 'not-published' | 'failed' | Published;

export interface LegalScreenProps {
  readonly business: string;
  readonly document: string;
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
}

async function readPublished(props: LegalScreenProps): Promise<Answer> {
  const address = `${props.apiOrigin}${PUBLIC_PREFIX}${encodeURIComponent(props.business)}/legal/${encodeURIComponent(props.document)}`;
  try {
    const response = await props.fetch(address);
    if (response.status === 404) return 'not-published';
    if (!response.ok) return 'failed';
    const body = (await response.json()) as Partial<Published>;
    const { version, publishedAt, body: words } = body;
    if (typeof version !== 'string' || typeof publishedAt !== 'string') return 'failed';
    return typeof words === 'string' ? { version, publishedAt, body: words } : 'failed';
  } catch {
    return 'failed';
  }
}

export function LegalScreen(props: LegalScreenProps): ReactElement {
  const [answer, setAnswer] = useState<Answer>('reading');
  const title = PUBLIC_DOCUMENTS.find(([name]) => name === props.document)?.[1];
  const { business, document, apiOrigin, fetch } = props;
  useEffect(() => {
    let current = true;
    void (async () => {
      const next = await readPublished({ business, document, apiOrigin, fetch });
      if (current) setAnswer(next);
    })();
    return () => {
      current = false;
    };
  }, [business, document, apiOrigin, fetch]);

  return (
    <div data-screen="legal">
      {typeof answer === 'string' ? (
        <div className="readstate" data-outcome={answer}>
          <Empty title={STATES[answer]} />
        </div>
      ) : (
        <Card
          title={title ?? 'Legal document'}
          sub={`Version ${answer.version}, published ${answer.publishedAt.slice(0, 10)}`}
        >
          {paragraphsOf(answer.body).map((paragraph, index) => (
            <p key={index} data-paragraph="">
              {paragraph}
            </p>
          ))}
        </Card>
      )}
      <OtherDocuments business={business} document={document} />
    </div>
  );
}

const paragraphsOf = (body: string): readonly string[] =>
  body
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');

/** The business's other public documents, and the way back to sign-in. */
function OtherDocuments(props: {
  readonly business: string;
  readonly document: string;
}): ReactElement {
  return (
    <nav aria-label="Legal documents">
      {PUBLIC_DOCUMENTS.filter(([name]) => name !== props.document).map(([name, words]) => (
        <p key={name}>
          <a href={pathTo('agency:legal', { business: props.business, document: name })}>{words}</a>
        </p>
      ))}
      <p>
        <a href={pathTo('agency:sign-in')}>Back to sign in</a>
      </p>
    </nav>
  );
}

const STATES: Readonly<Record<Exclude<Answer, Published>, string>> = {
  reading: 'Reading the document…',
  'not-published': 'This document is not published.',
  failed: 'The document could not be read. Try again later.',
};
