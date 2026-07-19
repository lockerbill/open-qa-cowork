import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/node_modules/**', '**/coverage/**'],
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
          ],
        },
      ],
    },
  },
);
