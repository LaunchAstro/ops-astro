// SPDX-License-Identifier: AGPL-3.0-only
//
// The map tests switch readers by handing the screen each member's subject as
// its grant key. The app keys its reads by `grantKeyOf` instead, so that
// stand-in holds only if the app's key also tells two people in one business
// apart, and one person in two businesses.

import { describe, expect, it } from 'vitest';
import { grantKeyOf } from '../../apps/web/src/session/token.ts';

describe("the app's grant key", () => {
  it('differs for two people in one business, and for one person in two businesses', () => {
    const ada = grantKeyOf({ businessKey: 'alpha', email: 'ada@example.test' });
    const ben = grantKeyOf({ businessKey: 'alpha', email: 'ben@example.test' });
    const adaElsewhere = grantKeyOf({ businessKey: 'bravo', email: 'ada@example.test' });
    expect(ada).not.toBe(ben);
    expect(ada).not.toBe(adaElsewhere);
  });
});
