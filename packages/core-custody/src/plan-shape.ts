// SPDX-License-Identifier: AGPL-3.0-only
//
// The shape a completed plan answer must have before custody gives it back
// (#1620 P3, `plan-answer.ts`). The schema is closed: every typed thing in
// the answer, an output item or a part, names one row of PAYLOADS, and that
// row's checks pass on its fields. An unknown type, a type in the wrong place
// or a bad payload makes the answer malformed, and it is withheld. Fields a
// row doesn't name are left to the secret checks. Citations are not in the
// schema, so an answer that carries one is withheld until a task needs them.

type Check = (value: unknown) => boolean;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text: Check = (value) => typeof value === 'string';
const count: Check = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
const listOf =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every((item) => check(item));
const fields =
  (shape: Readonly<Record<string, Check>>): Check =>
  (value) =>
    record(value) && Object.entries(shape).every(([key, check]) => check(value[key]));

/** The types the schema allows: output items, then the parts they hold. */
type Kind = 'message' | 'function_call' | 'reasoning' | 'output_text' | 'refusal' | 'summary_text';

/** A typed thing whose type is one of these rows of PAYLOADS, with that row's fields. */
function typed(...types: readonly Kind[]): Check {
  return (value) => {
    if (!record(value)) return false;
    const type = types.find((name) => name === value['type']);
    return type !== undefined && fields(PAYLOADS[type])(value);
  };
}

/** Each allowed type and the checks on its fields: items, then the parts they hold. */
const PAYLOADS: Readonly<Record<Kind, Readonly<Record<string, Check>>>> = {
  message: {
    role: (value: unknown) => value === 'assistant',
    content: listOf(typed('output_text', 'refusal')),
  },
  function_call: { name: text, arguments: text, call_id: optional(text) },
  reasoning: { summary: listOf(typed('summary_text')), encrypted_content: optional(text) },
  output_text: { text, annotations: optional(listOf(typed())) },
  refusal: { refusal: text },
  summary_text: { text },
};

const USAGE = fields({ input_tokens: count, output_tokens: count, total_tokens: count });

/** Whether a completed response has the closed shape: its id, model, typed output and usage counts. */
export const wellShaped: Check = fields({
  id: text,
  model: text,
  output: listOf(typed('message', 'function_call', 'reasoning')),
  usage: optional(USAGE),
});
