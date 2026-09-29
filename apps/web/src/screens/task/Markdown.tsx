// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's own markdown, drawn as React elements (MP-4-7, TA-10).
//
// **Nothing the text says becomes markup.** The brief is typed by a person or
// an agent, so it is split into blocks and drawn as elements this file names:
// headings, lists, paragraphs, bold and inline code. A tag in the text is text
// on the screen. A link is drawn as its words, never as an address to follow,
// so a brief cannot put a `javascript:` address in front of a person.

import type { ReactElement, ReactNode } from 'react';

type Block =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: 'paragraph'; readonly lines: readonly string[] };

const HEADING = /^\s*#{1,4}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

function blocksOf(source: string): readonly Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const close = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', lines: paragraph });
    paragraph = [];
  };
  for (const line of source.split('\n')) {
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (line.trim() === '') {
      close();
    } else if (heading !== null) {
      close();
      blocks.push({ kind: 'heading', text: heading[1] ?? '' });
    } else if (bullet !== null || numbered !== null) {
      close();
      const ordered = numbered !== null;
      const item = (bullet ?? numbered)?.[1] ?? '';
      const last = blocks.at(-1);
      if (last?.kind === 'list' && last.ordered === ordered) {
        blocks[blocks.length - 1] = { ...last, items: [...last.items, item] };
      } else {
        blocks.push({ kind: 'list', ordered, items: [item] });
      }
    } else {
      paragraph.push(line);
    }
  }
  close();
  return blocks;
}

/** `**bold**`, `` `code` `` and `[words](address)` inside one line; the rest is text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > at) out.push(text.slice(at, start));
    const [, bold, code, words] = match;
    if (bold !== undefined) out.push(<strong key={start}>{bold}</strong>);
    else if (code !== undefined) out.push(<code key={start}>{code}</code>);
    else out.push(words);
    at = start + match[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function Markdown(props: { readonly source: string }): ReactElement {
  return (
    <div className="md tt__prose">
      {blocksOf(props.source).map((block, index) => {
        if (block.kind === 'heading') {
          return (
            <p key={index} className="md__h">
              <strong>{inline(block.text)}</strong>
            </p>
          );
        }
        if (block.kind === 'list') {
          const items = block.items.map((item, at) => <li key={at}>{inline(item)}</li>);
          return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
        }
        return (
          <p key={index}>
            {block.lines.flatMap((line, at) =>
              at === 0 ? inline(line) : [<br key={`br-${at}`} />, ...inline(line)],
            )}
          </p>
        );
      })}
    </div>
  );
}
