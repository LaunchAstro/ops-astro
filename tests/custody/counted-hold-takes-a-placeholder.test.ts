// countedHold writes its argument into SQL text, and custody's index exports
// it to every package. It takes a numbered placeholder only: other text fails
// the type check, and anything that reaches it untyped is refused when it runs.

import { describe, expect, it } from 'vitest';
import { countedHold } from '../../packages/core-custody/src/index.ts';

const hostile = "'{}') or true or (1";

describe('the counted-hold condition', () => {
  it('takes a numbered placeholder and binds the causes through it', () => {
    expect(countedHold('$3')).toContain('any($3::text[])');
    expect(countedHold('$12')).toContain('any($12::text[])');
  });

  it('refuses other text at the type check and when it runs', () => {
    const fromARequest: string = hostile;
    // @ts-expect-error -- only a numbered placeholder such as '$3' is accepted
    expect(() => countedHold(fromARequest)).toThrow('a numbered placeholder');
  });

  it('refuses untyped text that the type check cannot see, without echoing it', () => {
    const body = JSON.stringify({ slot: hostile });
    expect(() => countedHold(JSON.parse(body).slot)).toThrow('a numbered placeholder');
    expect(() => countedHold(JSON.parse(body).slot)).not.toThrow(hostile);
  });

  it('refuses the numeric forms the type check lets through', () => {
    for (const form of ['$01', '$0', '$ 1', '$1 ', '$-1', '$1.5', '$1e3', '$0x1f', '$']) {
      expect(() => countedHold(form as `$${number}`), form).toThrow('a numbered placeholder');
    }
  });
});
