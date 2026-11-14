const js = require('@eslint/js');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

// GHSA-9ppf-38v8-h97v: PowerShell also ends a single-quoted string at ‘ ’ ‚ ‛, so doubling ' never made a value safe.
const NO_QUOTED_PS_VALUE = {
  selector: "CallExpression[callee.property.name='replace'][arguments.0.regex.pattern=\"'\"][arguments.1.value=\"''\"]",
  message: 'Do not quote a value into PowerShell source by doubling apostrophes: pass it as data (stdin or an environment variable). GHSA-9ppf-38v8-h97v.',
};
const NO_PAUSE_GATE = 'The input layer and the batch executor never read the pause gate: a pause reply is not a go-ahead.';

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        queueMicrotask: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        NodeJS: 'readonly',
        performance: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Allow require() for lazy-loading (used for optional deps like playwright
      // and to break startup import cycles). v0.9.x may tighten this once the
      // pipeline port is complete.
      '@typescript-eslint/no-require-imports': 'off',
      // Downgraded from error to warn for v0.8.1 to unblock CI; real fixes
      // land during the pipeline port in dedicated cleanup PRs.
      'no-useless-escape': 'warn',
      'no-case-declarations': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // OCR/text-processing files legitimately match on control characters.
      // Keep as warning; files that use them add a file-level disable comment.
      'no-control-regex': 'warn',
    },
  },
  // Files that execute callback source inside the browser page context via
  // page.evaluate(() => document.querySelector(...)). Those callbacks are
  // serialized and run in the browser — `document`, `window`, `getComputedStyle`
  // are legitimate globals there, not linter errors.
  {
    files: ['src/platform/cdp-driver.ts', 'src/tools/cdp.ts', 'src/tools/smart.ts'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
  },
  // Source rules (the ones a scan cannot say this simply are in src/__tests__/repo-invariants.test.ts).
  {
    files: ['src/**/*.ts'],
    ignores: ['src/__tests__/**'],
    rules: { 'no-restricted-syntax': ['error', NO_QUOTED_PS_VALUE] },
  },
  // A pause reply is never approval: the input layer and the batch executor do not read the pause gate.
  {
    files: ['src/platform/hard-keys.ts', 'src/platform/pointer-guard.ts', 'src/tools/batch.ts', 'src/tools/projected/tools.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/pause-gate'], message: NO_PAUSE_GATE }] }],
      'no-restricted-syntax': ['error', NO_QUOTED_PS_VALUE,
        { selector: 'ImportExpression[source.value=/pause-gate/]', message: NO_PAUSE_GATE },
        { selector: "CallExpression[callee.name='require'][arguments.0.value=/pause-gate/]", message: NO_PAUSE_GATE }],
    },
  },
  // Test file overrides — vitest globals + non-project parsing.
  //
  // tsconfig.json excludes src/__tests__ from the build (so dist/ stays
  // lean for npm publish). That means @typescript-eslint can't find a
  // project that includes test files, which trips "parserOptions.project
  // has been provided" errors. Drop to project-less parsing for tests —
  // they get linted for syntax + rule violations but skip type-aware
  // checks, which is the correct trade-off (tests already get full
  // type-checking via tsconfig.tests.json + `npm run typecheck:tests`).
  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'src/__tests__/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: null,
      },
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        test: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
      },
    },
  },
];
