import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**'],
  },
  {
    rules: {
      // The render loop deliberately reads refs that the linter can't prove are
      // stable, and several deps are omitted on purpose (each one is commented
      // at the call site with the reason). Left as a warning so genuine
      // mistakes still surface.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
