// SPDX-License-Identifier: AGPL-3.0-only
/** One chosen occurrence belongs to one person, even when display names repeat. */
export interface MentionBinding {
  readonly id: string;
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

const boundary = (character: string | undefined): boolean =>
  character === undefined || !/[\p{L}\p{N}_@]/u.test(character);

export function intactMention(body: string, binding: MentionBinding, names: readonly string[]) {
  const token = `@${binding.name}`;
  return (
    body.slice(binding.start, binding.end) === token &&
    boundary(body[binding.start - 1]) &&
    boundary(body[binding.end]) &&
    !names.some(
      (name) => name.startsWith(`${binding.name} `) && body.startsWith(`@${name}`, binding.start),
    )
  );
}

/** Translate untouched tokens across a textarea edit. An edit inside a token unbinds it. */
export function editedMentions(
  before: string,
  after: string,
  bindings: readonly MentionBinding[],
  names: readonly string[],
  caret?: number,
): readonly MentionBinding[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  // The caret disambiguates deleting the first of two identical tokens.
  if (caret !== undefined) {
    const anchoredEnd = before.length - (after.length - caret);
    const anchoredStart = Math.min(start, anchoredEnd, caret);
    if (
      anchoredEnd >= 0 &&
      before.slice(anchoredEnd) === after.slice(caret) &&
      anchoredEnd + caret - 2 * anchoredStart <= oldEnd + newEnd - 2 * start
    ) {
      oldEnd = anchoredEnd;
      newEnd = caret;
      start = anchoredStart;
    }
  }
  return bindings.flatMap((binding) => {
    const next =
      binding.end <= start
        ? binding
        : binding.start >= oldEnd
          ? {
              ...binding,
              start: binding.start + newEnd - oldEnd,
              end: binding.end + newEnd - oldEnd,
            }
          : null;
    return next !== null && intactMention(after, next, names) ? [next] : [];
  });
}

/** Recover an existing draft once; never infer recipients from newly typed unselected names. */
export function seedMentions(
  body: string,
  selected: readonly string[],
  people: readonly { readonly personId: string; readonly name: string }[],
): readonly MentionBinding[] {
  const bindings: MentionBinding[] = [];
  for (const id of selected) {
    const person = people.find((item) => item.personId === id);
    if (person === undefined) continue;
    const token = `@${person.name}`;
    let start = body.indexOf(token);
    while (start !== -1) {
      const binding = { id, name: person.name, start, end: start + token.length };
      if (
        !bindings.some((item) => item.start === binding.start) &&
        intactMention(
          body,
          binding,
          people.map((item) => item.name),
        )
      ) {
        bindings.push(binding);
        break;
      }
      start = body.indexOf(token, start + token.length);
    }
  }
  return bindings;
}
