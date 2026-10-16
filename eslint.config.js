import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow intentionally unused args/vars when prefixed with "_" (e.g. Express's `next`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Make type-only imports explicit; pairs with `verbatimModuleSyntax`.
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // Must be last: turns off ESLint rules that would fight Prettier's formatting.
  prettier,
);
