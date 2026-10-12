// SPDX-License-Identifier: AGPL-3.0-only

// The source as CSS Syntax reads it: inside a quoted string a backslash and
// a newline (\n, \r\n, \r or \f) are a line continuation, which adds nothing,
// so `[class~="ter\<newline>m__tip"]` names `term__tip`. Comments, other
// escapes and everything outside strings are kept as written.
export function continued(css: string): string {
  let out = '';
  let quote = '';
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index] ?? '';
    if (quote === '' && css.startsWith('/*', index)) {
      const end = css.indexOf('*/', index + 2);
      const stop = end === -1 ? css.length : end + 2;
      out += css.slice(index, stop);
      index = stop - 1;
    } else if (character === '\\') {
      const newline = /^(?:\r\n|[\n\r\f])/u.exec(css.slice(index + 1))?.[0];
      if (quote !== '' && newline !== undefined) index += newline.length;
      else {
        out += css.slice(index, index + 2);
        index += 1;
      }
    } else {
      if (quote === '' && (character === '"' || character === "'")) quote = character;
      else if (character === quote || /[\n\r\f]/u.test(character)) quote = '';
      out += character;
    }
  }
  return out;
}
