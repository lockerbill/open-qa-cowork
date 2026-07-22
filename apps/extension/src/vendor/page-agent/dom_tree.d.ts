/**
 * Type declarations for dom_tree.js.
 *
 * @openqa-edit merged from upstream `dom/dom_tree/index.d.ts` and
 * `dom/dom_tree/type.ts` (pinned base commit, see ../VENDORED.md) so the
 * vendored dom_tree.js is a single module with a sibling declaration file.
 */

// --- from dom/dom_tree/type.ts ---------------------------------------------
// FlatDomTree: flattened DOM tree structure for efficient storage/traversal.
// Each node is indexed via `map`; text and element nodes are distinguished.

export interface FlatDomTree {
	rootId: string
	map: Record<string, DomNode>
}

export type DomNode = TextDomNode | ElementDomNode | InteractiveElementDomNode

export interface TextDomNode {
	type: 'TEXT_NODE'
	text: string
	isVisible: boolean
	[key: string]: unknown
}

export interface ElementDomNode {
	tagName: string
	attributes?: Record<string, string>
	xpath?: string
	children?: string[]
	isVisible?: boolean
	isTopElement?: boolean
	isInViewport?: boolean
	isNew?: boolean
	isInteractive?: false
	highlightIndex?: number
	extra?: Record<string, any>
	[key: string]: unknown
}

export interface InteractiveElementDomNode {
	tagName: string
	attributes?: Record<string, string>
	xpath?: string
	children?: string[]
	isVisible?: boolean
	isTopElement?: boolean
	isInViewport?: boolean
	isInteractive: true
	highlightIndex: number
	/** Live DOM reference for the interactive element. */
	ref: HTMLElement
	[key: string]: unknown
}

// --- from dom/dom_tree/index.d.ts -------------------------------------------

interface DomTreeArgs {
	doHighlightElements?: boolean
	focusHighlightIndex?: number
	viewportExpansion?: number
	debugMode?: boolean
	interactiveBlacklist?: Element[]
	interactiveWhitelist?: Element[]
	highlightOpacity?: number
	highlightLabelOpacity?: number
}

declare const domTree: (args?: DomTreeArgs) => FlatDomTree

export default domTree
