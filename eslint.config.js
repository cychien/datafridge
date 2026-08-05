import eslint from '@eslint/js'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'Core must use the injected Clock, never the wall clock.',
        },
        {
          object: 'Math',
          property: 'random',
          message: 'Core must use the injected random source.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'Core must use the injected Clock for timers.' },
        { name: 'clearTimeout', message: 'Core must use the injected Clock for timers.' },
        { name: 'setInterval', message: 'Core must not own an event loop.' },
        { name: 'clearInterval', message: 'Core must not own an event loop.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="Date"]',
          message: 'Core must use the injected Clock, never the wall clock.',
        },
      ],
    },
  },
)
