// SPDX-License-Identifier: AGPL-3.0-only
import { messageProvenanceErrors } from './scripts/provenance.mjs';

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  defaultIgnores: false,
  plugins: [
    {
      rules: {
        provenance: ({ raw }) => {
          const errors = messageProvenanceErrors(raw);
          return [errors.length === 0, errors.join(' ')];
        },
      },
    },
  ],
  rules: {
    provenance: [2, 'always'],
    'body-max-line-length': [1, 'always', 100],
    'subject-case': [2, 'never', ['pascal-case', 'upper-case']],
    'type-enum': [
      2,
      'always',
      ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'test'],
    ],
  },
};
