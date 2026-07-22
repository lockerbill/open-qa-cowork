/**
 * Kill-switch overlay (auto-test-mode-spec §6.6): fixed top-right pill while
 * a run is active. Stop click → onStop. Any TRUSTED keydown/mousedown outside
 * the overlay → onIntervene (the human grabbed the wheel — pause, don't
 * kill). Deliberately no input blocking in v1. Tagged data-openqa-ignore so
 * it never appears in observations.
 */

export interface StopOverlayHandle {
  hide(): void;
}

export function showStopOverlay(
  onStop: () => void,
  onIntervene?: () => void,
  doc: Document = document,
): StopOverlayHandle {
  const host = doc.createElement('div');
  host.setAttribute('data-openqa-ignore', 'true');
  host.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:2147483646;' +
    'display:flex;align-items:center;gap:8px;padding:8px 14px;' +
    'background:#1f2937;color:#f9fafb;border-radius:9999px;' +
    'font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35);';

  const label = doc.createElement('span');
  label.textContent = '⏸ Auto test running';
  host.appendChild(label);

  const stopButton = doc.createElement('button');
  stopButton.type = 'button';
  stopButton.textContent = 'Stop';
  stopButton.style.cssText =
    'border:0;border-radius:9999px;padding:3px 12px;cursor:pointer;' +
    'background:#dc2626;color:#fff;font:inherit;';
  stopButton.addEventListener('click', () => onStop());
  host.appendChild(stopButton);

  const onUserInput = (e: Event) => {
    if (!e.isTrusted) return;
    if (e.target instanceof Node && host.contains(e.target)) return;
    onIntervene?.();
  };
  doc.addEventListener('keydown', onUserInput, true);
  doc.addEventListener('mousedown', onUserInput, true);

  (doc.body ?? doc.documentElement).appendChild(host);

  return {
    hide() {
      doc.removeEventListener('keydown', onUserInput, true);
      doc.removeEventListener('mousedown', onUserInput, true);
      host.remove();
    },
  };
}
