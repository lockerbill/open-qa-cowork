/** Trigger a file download from the side panel (spec §8.1 exports). */
export function downloadText(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadJson = (filename: string, data: unknown) =>
  downloadText(filename, JSON.stringify(data, null, 2), 'application/json');

export const downloadMarkdown = (filename: string, md: string) =>
  downloadText(filename, md, 'text/markdown');

export const downloadTypeScript = (filename: string, ts: string) =>
  downloadText(filename, ts, 'text/typescript');
