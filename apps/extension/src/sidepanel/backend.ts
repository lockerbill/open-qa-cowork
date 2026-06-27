import type { PageModel, TestSession } from '@qa-copilot/shared';

export interface AnalyzeResponse {
  summary: string;
  risks: string[];
  suggestedTests: string[];
}

export interface GenerateResponse {
  artifactId: string;
  content: string;
  format: string;
  filename?: string;
  selectorWarnings?: { eventId: string; targetLabel?: string; message: string }[];
}

async function post<T>(backendUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${backendUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Backend ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export function analyzePage(
  backendUrl: string,
  payload: { pageModel: PageModel; question?: string; environment?: string },
): Promise<AnalyzeResponse> {
  return post<AnalyzeResponse>(backendUrl, '/api/page/analyze', payload);
}

export function generateTestCases(
  backendUrl: string,
  payload: { pageModel: PageModel; format?: string; focus?: string },
): Promise<GenerateResponse> {
  return post<GenerateResponse>(backendUrl, '/api/generate/test-cases', payload);
}

export function generateBugReport(
  backendUrl: string,
  payload: {
    session: TestSession;
    pageModel: PageModel | null;
    userNote: string;
    includeConsoleErrors?: boolean;
    includeNetworkFailures?: boolean;
  },
): Promise<GenerateResponse> {
  return post<GenerateResponse>(backendUrl, '/api/generate/bug-report', payload);
}

export function generatePlaywright(
  backendUrl: string,
  payload: { session: TestSession; enrich?: boolean },
): Promise<GenerateResponse> {
  return post<GenerateResponse>(backendUrl, '/api/generate/playwright', payload);
}
