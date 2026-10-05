// SPDX-License-Identifier: AGPL-3.0-only
//
// The copy finder's command line (scripts/privacy/find-copies.mjs), read as a
// closed grammar: four known options, each at most once, a value never taken
// from the next option, an id parsed as exactly 8-4-4-4-12 hex digits, and the
// text with its white space folded before its length is counted.

const HEX = '0123456789abcdef';

/** Unicode's white space, one list for the text here and for the rows in SQL. */
export const WHITE =
  '\t\n\v\f\r \u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';

/**
 * Whether one character is a letter, a digit or a mark joined to a letter, by
 * its Unicode category (सीता writes two of its sounds as marks).
 */
const isLetterOrDigit = (character) => /^[\p{L}\p{M}\p{N}]$/u.test(character);

/** Whether a text or stored name has enough letters or digits to name a person. */
export const namesSomeone = (text) =>
  [...text].filter((character) => isLetterOrDigit(character)).length >= 4;

/** The text with each run of white space as one space, and none at its ends. */
function spaced(text) {
  const words = [];
  let word = '';
  for (const character of text) {
    if (!WHITE.includes(character)) word += character;
    else if (word !== '') {
      words.push(word);
      word = '';
    }
  }
  if (word !== '') words.push(word);
  return words.join(' ');
}

/** The id in canonical lower case, or null unless it is 8-4-4-4-12 hex digits. */
function uuid(text) {
  const id = text.toLowerCase();
  if (id.length !== 36) return null;
  for (let at = 0; at < id.length; at += 1) {
    const dash = at === 8 || at === 13 || at === 18 || at === 23;
    if (dash ? id[at] !== '-' : !HEX.includes(id[at])) return null;
  }
  return id;
}

/** The command line as options, or `{ error }`: a closed set of options, each once. */
export function parse(args) {
  const options = { business: undefined, text: undefined, ids: [], exportRows: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--export') {
      if (options.exportRows) return { error: '--export is given twice' };
      options.exportRows = true;
      continue;
    }
    if (arg !== '--business' && arg !== '--text' && arg !== '--id') {
      return { error: `unknown argument ${JSON.stringify(arg)}` };
    }
    index += 1;
    const value = args[index];
    if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
    if (arg === '--id') {
      const id = uuid(value);
      if (id === null) return { error: `--id needs a UUID, not ${JSON.stringify(value)}` };
      options.ids.push(id);
    } else {
      const key = arg === '--text' ? 'text' : 'business';
      if (options[key] !== undefined) return { error: `${arg} is given twice` };
      options[key] = key === 'text' ? spaced(value) : value;
    }
  }
  if (options.text !== undefined && !namesSomeone(options.text)) {
    return { error: '--text needs at least 4 letters or digits that name the person' };
  }
  if (options.text === undefined && options.ids.length === 0) {
    return { error: '--text or --id needs to name the person' };
  }
  if (options.business === undefined || options.business === '') {
    return { error: '--business needs the key of the business the request is for' };
  }
  return options;
}
