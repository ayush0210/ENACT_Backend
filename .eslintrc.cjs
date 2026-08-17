module.exports = {
  env: {
    es2022: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  extends: ['eslint:recommended', 'plugin:promise/recommended'],
  plugins: ['promise'],
  rules: {
    // Catch real bugs — unused variables are errors, not warnings
    'no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    // Unhandled promise rejections crash Node silently
    'promise/catch-or-return': ['error', { allowFinally: true }],
    'promise/always-return': 'error',
    'promise/no-return-wrap': 'error',
    'promise/param-names': 'error',
    'promise/no-nesting': 'warn',
    // Structural correctness
    'no-duplicate-imports': 'error',
    'no-process-exit': 'error',
    'no-console': 'off',
  },
  ignorePatterns: [
    'node_modules/',
    'public/',
    'database_export/',
    '*.sql',
    'tips.json',
  ],
};
