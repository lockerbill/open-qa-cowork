/**
 * Dedupe gate between auto-mode execution and the manual session recorder
 * (auto-test-mode-spec §6.4.9). The vendored primitives dispatch synthetic
 * DOM events internally, so we cannot tag each event object; instead the
 * executor brackets dispatch with begin/end and the recorder skips untrusted
 * events while the bracket is open. Trusted (human) events still record —
 * and in later milestones pause the run.
 */

let depth = 0;

export function beginAutoDispatch(): void {
  depth += 1;
}

export function endAutoDispatch(): void {
  depth = Math.max(0, depth - 1);
}

export function isAutoDispatchActive(): boolean {
  return depth > 0;
}

/**
 * True when the recorder should ignore this event: anything observed during
 * the dispatch bracket is a product of the auto action — including events the
 * browser marks TRUSTED, e.g. the submit event fired by the form-submission
 * algorithm after our synthetic click on a submit button. The executor's
 * explicit source:'auto' mirror is the timeline's single entry. Real human
 * input during a run is the stop-overlay's job (pause), not the recorder's.
 */
export function shouldSkipRecorderEvent(_e: Event): boolean {
  return isAutoDispatchActive();
}
