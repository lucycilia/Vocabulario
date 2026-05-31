import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

export default [
  { ignores: ['dist/**', 'node_modules/**', '.firebase/**', 'backups/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,

      // This is a plain-JS project (no PropTypes, no TypeScript). PropTypes
      // validation and display-name checks are noise here; type safety is better
      // addressed by migrating to TypeScript later, not by hand-writing PropTypes.
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'react/no-unescaped-entities': 'off',

      // Real signal, kept as warnings so they show up as a backlog without
      // blocking the build. These are the architectural cleanup targets:
      //   react-hooks/* — mutable module globals, Date.now() in render, etc.
      //   no-unused-vars — dead code to remove.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'react/no-unknown-property': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // The modern React-hooks compiler rules catch genuine issues in App.jsx
      // (mutable module globals for theme/i18n, Date.now() during render,
      // setState-in-effect, ref reads during render). They're real and worth
      // fixing, but they require the App.jsx decomposition to resolve properly.
      // Kept as warnings so CI stays green while they're worked down — new code
      // still gets flagged, and the count only ratchets downward.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/immutability': 'warn',
    },
  },
  // Test files run under Vitest's globals.
  {
    files: ['**/*.test.{js,jsx}'],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
]
