// SPDX-License-Identifier: AGPL-3.0-only
//
// A word inside an Astro expression is code, not body copy, whatever the
// expression holds before it: a quoted closing brace, a template literal, a
// comment, or a `>` inside an attribute's expression. Each is refused; a word
// in text after a closed expression is still accepted.

import { describe, expect, it } from 'vitest';
import { checkEnvelope, type CorrectionTarget } from '../../packages/core-connectors/src/index.ts';

const TARGET: CorrectionTarget = {
  path: 'src/pages/about.astro',
  word: 'alongside',
  replacement: 'beside',
};

/** A page whose sixth line is `text`. */
const source = (text: string): string =>
  [
    '---',
    "const x = '';",
    '---',
    '<Layout>',
    '  <section>',
    text,
    '  </section>',
    '</Layout>',
    '',
  ].join('\n');

/** That page changed by the one word only. */
function proposed(line: string) {
  const after = source(line.replace('alongside', 'beside'));
  return { files: [{ path: TARGET.path, before: source(line), after }] };
}

describe('the envelope reads strings and comments inside an expression', () => {
  it.each([
    ['a double-quoted closing brace', '    <p>{"}" + " alongside"}</p>'],
    ['a single-quoted closing brace', "    <p>{'}' + ' alongside'}</p>"],
    ['a template literal holding a closing brace', '    <p>{`}${x} alongside`}</p>'],
    ['a block comment holding a closing brace', "    <p>{x /* } */ ? 'alongside' : ''}</p>"],
    ['a line comment holding a closing brace', "    <p>{x // }\n ? 'alongside' : ''}</p>"],
    ['an attribute expression holding a `>`', "    <Card label={x > 1 ? 'alongside' : ''} />"],
  ])('refuses the word after %s', (_name, line) => {
    expect(checkEnvelope(proposed(line), TARGET)).toMatchObject({
      ok: false,
      code: 'CHANGE_ENVELOPE_EXCEEDED',
    });
  });

  it('accepts the word in text after a closed expression holding a quoted brace', () => {
    expect(
      checkEnvelope(proposed("    <p>{'}'} We walk alongside you.</p>"), TARGET),
    ).toMatchObject({
      ok: true,
      value: { line: 6 },
    });
  });
});
