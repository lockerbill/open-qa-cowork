export * from './types.js';
export * from './selector.js';
export * from './redaction.js';
export * from './playwright.js';
export * from './sessionMarkdown.js';
// Auto Test Mode types live behind the '@qa-copilot/shared/auto' subpath, NOT
// this barrel: auto/action.ts depends on zod at runtime, and re-exporting it
// here would drag zod into every consumer's bundle — including the MV3
// content script, where the extra crxjs chunk breaks content-script loading.
