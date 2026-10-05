// countedHold writes its argument into SQL text, and custody's index exports
// it to every package. Its parameter takes a numbered placeholder only, so text
// from anywhere else (a request field, a row read back) fails the type check.

import { describe, expect, it } from 'vitest';
import { countedHold } from '../../packages/core-custody/src/index.ts';

describe('the counted-hold condition', () => {
  it('takes a numbered placeholder and binds the causes through it', () => {
    expect(countedHold('$3')).toContain('any($3::text[])');
  });

  it('refuses any other text at the type check', () => {
    const fromARequest: string = "'{}') or true or (1";
    // @ts-expect-error -- only a numbered placeholder such as '$3' is accepted
    expect(countedHold(fromARequest)).toContain(fromARequest);
  });
});
