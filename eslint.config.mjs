// The same lint as AUGUR's own repository (its ADR 0043): ESLint's and typescript-eslint's recommended rules.
// `pnpm lint` runs it; CI runs it on every PR.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/storybook-static/**', '**/.turbo/**', '**/*.d.ts', '**/coverage/**', 'out/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // A leading underscore says "unused on purpose", as in `const { secret: _, ...rest } = row`.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true }],
      // `a && b()` and `cond ? x() : y()` as statements are a common, readable shorthand.
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    },
  },
  {
    // A pg Pool without an error listener ends the process when Postgres restarts (REVIEW.md): wrap it in
    // steadyPool from @augur/service-kit. Tests' pools end with the test.
    files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
    ignores: ['**/*.test.*', '**/*.testing.ts', '**/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: ":matches(NewExpression[callee.property.name='Pool'], NewExpression[callee.name='Pool']):not(CallExpression[callee.name='steadyPool'] > NewExpression, CallExpression[callee.property.name='steadyPool'] > NewExpression)",
          message: 'Wrap a new pg Pool in steadyPool() from @augur/service-kit, so a lost connection is logged instead of ending the process.',
        },
      ],
    },
  },
);
