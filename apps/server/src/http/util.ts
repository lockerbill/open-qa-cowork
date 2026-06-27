import { randomUUID } from 'node:crypto';

export function artifactId(): string {
  return `artifact_${randomUUID()}`;
}

/** Strip code fences and parse JSON from an LLM response, tolerating prose. */
export function parseJsonLoose<T>(text: string): T | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Remove accidental code fences from a markdown/TS artifact. */
export function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/, '')
    .trim();
}
