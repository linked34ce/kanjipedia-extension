import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';

export default defineConfig([
  globalIgnores([
    '.local/**',
    'artifacts/**',
    'data/**',
    'playwright-report/**',
    'extension/content.js',
    'extension/data.js',
  ]),
  js.configs.recommended,
  {
    files: [
      'collector/**/*.js',
      'scripts/**/*.js',
      'tests/**/*.js',
      'eslint.config.js',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['extension/source.js', 'tests/browser.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['shared/**/*.js'],
    languageOptions: { globals: { URL: 'readonly' } },
  },
  // 整形ルールがPrettierと競合しないよう、最後に適用する。
  prettier,
]);
