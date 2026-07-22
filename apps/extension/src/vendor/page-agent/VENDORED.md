# Vendored: page-agent page-controller internals

Selected files from [`alibaba/page-agent`](https://github.com/alibaba/page-agent)
(MIT), vendored — not npm-depended — because the APIs we need are `@private`,
the `flatTreeToString` serialization format is prompt-load-bearing, redaction
needs an in-serializer seam, and upstream's eval pathway
(`PageController.executeJavascript`) must not ship
(auto-test-mode-spec §4, §15).

- **Upstream repo:** https://github.com/alibaba/page-agent
- **Pinned base commit:** `da1db959558dcd49a6c489e76a23accfbda7b156`
- **Package at that commit:** `@page-agent/page-controller` v1.12.2
- **dom_tree.js secondary provenance:** ported by upstream from
  [`browser-use/browser-use`](https://github.com/browser-use/browser-use)
  0.5.9 (`d51b6e73daff7165fdd3e44debd667e7f5f7fdc5`) — see its file header.
- **Licenses:** `LICENSE-page-agent` (MIT, Alibaba/SimonLuvRamen),
  `LICENSE-browser-use` (MIT, Gregor Zunic).

## File provenance (upstream paths relative to `packages/page-controller/src/`)

| Vendored file | Upstream source | Why |
|---|---|---|
| `dom_tree.js` | `dom/dom_tree/index.js` | browser-use-derived DOM extractor: interactivity detection, visibility, top-element hit-testing, viewport expansion, highlight overlay, live element refs. |
| `dom_tree.d.ts` | `dom/dom_tree/index.d.ts` + `dom/dom_tree/type.ts` (merged) | Types for the extractor's flat tree. |
| `dom.ts` | `dom/index.ts` | Flat-tree post-processing + `flatTreeToString` LLM serialization (indexed elements, indentation, attribute allowlist, `*new*` markers, text capping). |
| `get-page-info.ts` | `dom/getPageInfo.ts` | Scroll/viewport metrics for the observation header. |
| `actions.ts` | `actions.ts` | Spec-order pointer/mouse click sequence with hit-test targeting; input via native value setter; contenteditable Plan A → verify → Plan B fallback; select; scroll helpers. |
| `utils.ts` | `utils/index.ts` | `getNativeValueSetter`, pointer simulation, pass-through toggling, type guards, `waitFor`. |
| `patches/react.ts` | `patches/react.ts` | Marks React root containers non-interactive (prevents whole-page false positive). |

Deliberately NOT vendored: `PageController.ts` (we build our own `PageDriver`;
its `executeJavascript` eval pathway must not ship), `mask/` (drops the
`ai-motion` dependency; our stop overlay is simpler), `patches/antd.ts` (empty
stub upstream), and everything from `packages/core`, `packages/llms`,
`packages/ui`, `packages/extension`.

## Local changes

Every local change is marked `// @openqa-edit <reason>` in place. Upstream's
own `@edit` comments (documenting its browser-use divergence) are preserved.
Summary:

- `dom_tree.js`: `data-openqa-ignore` added to the ignore-attribute subtree
  check (excludes OpenQA's own overlay/panels from observations).
- `dom.ts`: imports flattened to sibling `dom_tree.js`/`dom_tree.d.ts`;
  highlights/debug off by default behind `DomConfig.debugHighlights`;
  `flatTreeToString` gained `opts.redactNode` — a per-node redaction seam at
  upstream's literal `@todo 数据脱敏过滤器`; index-access guards for this
  repo's `noUncheckedIndexedAccess` (no behavior change); `@openqa-edit relied
  upon` markers on `getFlatTree`, `flatTreeToString`, `getSelectorMap`.
- `actions.ts`: imports flattened; `@openqa-edit relied upon` markers on
  `clickElement`, `inputTextElement`, `selectOptionElement`,
  `scrollIntoViewIfNeeded`, `scrollVertically`. No eval pathway exists in this
  file (upstream's lives in un-vendored `PageController.ts`); CI greps this
  directory and fails on `eval(`/`new Function(`.
- `patches/react.ts`: dropped the unused `pageController` parameter and its
  type import (PageController is not vendored).
- `utils.ts`, `get-page-info.ts`: verbatim except the provenance header line.

## Import boundary

Only `apps/extension/src/content/auto/page-driver.ts` may import from this
directory — enforced by an ESLint `no-restricted-imports` rule in the root
`eslint.config.js`. Vendored code is excluded from our lint (upstream style);
the CI eval-grep is the only additional gate.

## Sync process (quarterly, or when a relevant upstream fix lands)

1. In an upstream clone:
   `git diff da1db959558dcd49a6c489e76a23accfbda7b156..HEAD -- packages/page-controller/src/{actions.ts,dom,utils,patches}`
2. Cherry-pick relevant hunks into the vendored files, preserving every
   `@openqa-edit` marker (they exist so these diffs stay legible).
3. Update the pinned base commit + package version at the top of this file.
4. Re-run the vendor smoke suite
   (`pnpm --filter @qa-copilot/extension test:e2e` — `vendor-smoke.spec.ts`)
   and the CI eval-grep.
