import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // vendor/page-agent is vendored upstream code (see its VENDORED.md): kept
    // in upstream style, excluded from our lint. Its gates are the CI
    // eval-grep and the import-boundary rule below.
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/extension/src/vendor/page-agent/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Structural prompt isolation (jira-integration spec, "Credential
    // isolation"). `backend.ts` builds every request to apps/server, and
    // `prompts/**` builds every LLM prompt — neither may reach for Jira code,
    // so Jira config or payloads cannot be serialized into either one.
    files: ['apps/extension/src/sidepanel/backend.ts', 'apps/server/src/prompts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/integrations/jira', '**/integrations/jira/**'],
              message:
                'Jira credentials and payloads must never reach a gateway request or an LLM prompt (jira-integration spec, "Credential isolation").',
            },
            // Repeated here because a later flat-config entry REPLACES this
            // rule's options for matching files — these files must keep both
            // restrictions.
            {
              group: ['**/vendor/page-agent', '**/vendor/page-agent/**'],
              message:
                'Only content/auto/page-driver.ts may import from vendor/page-agent (auto-test-mode-spec §3).',
            },
          ],
        },
      ],
    },
  },
  {
    // Vendor boundary (auto-test-mode-spec §3): only the PageDriver may
    // touch vendored page-agent internals, so the vendored surface stays
    // swappable and its serialization/redaction seam has a single consumer.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['apps/extension/src/content/auto/page-driver.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/vendor/page-agent', '**/vendor/page-agent/**'],
              message:
                'Only content/auto/page-driver.ts may import from vendor/page-agent (auto-test-mode-spec §3).',
            },
          ],
        },
      ],
    },
  },
);
