// Configuración mínima de ESLint (reglas recomendadas) para el backend en Node con módulos ES.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: {
      // Los parámetros y errores que empiezan con "_" se ignoran a propósito (por ejemplo, (_req, res) en Express).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
];
