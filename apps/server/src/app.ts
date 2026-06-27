import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { buildPlaywrightSpec, type TestSession } from '@qa-copilot/shared';
import { LLMError, type LLMProvider } from './llm/index.js';
import {
  analyzeSchema,
  bugReportSchema,
  playwrightSchema,
  testCasesSchema,
} from './http/schemas.js';
import { artifactId, parseJsonLoose, stripFences } from './http/util.js';
import { requestIdMiddleware } from './http/request-id.js';
import { defaultLogger, type Logger } from './logging/logger.js';
import {
  analyzeSystem,
  analyzeUser,
  bugReportSystem,
  bugReportUser,
  playwrightEnrichSystem,
  playwrightEnrichUser,
  testCasesSystem,
  testCasesUser,
} from './prompts/index.js';
import { ZodError } from 'zod';

/** Build the Express app with an injected LLM provider (tests pass a mock). */
export function createApp(provider: LLMProvider, logger: Logger = defaultLogger()): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '4mb' }));
  app.use(requestIdMiddleware(logger));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, provider: provider.name });
  });

  // --- POST /api/page/analyze ---
  app.post(
    '/api/page/analyze',
    asyncHandler(async (req, res) => {
      const body = analyzeSchema.parse(req.body);
      const text = await provider.complete({
        system: analyzeSystem(),
        user: analyzeUser(body.pageModel as never, body.question),
        maxTokens: 1024,
      });
      const parsed = parseJsonLoose<{
        summary: string;
        risks: string[];
        suggestedTests: string[];
      }>(text);
      res.json({
        summary: parsed?.summary ?? text.trim(),
        risks: parsed?.risks ?? [],
        suggestedTests: parsed?.suggestedTests ?? [],
      });
    }),
  );

  // --- POST /api/generate/test-cases ---
  app.post(
    '/api/generate/test-cases',
    asyncHandler(async (req, res) => {
      const body = testCasesSchema.parse(req.body);
      const text = await provider.complete({
        system: testCasesSystem(),
        user: testCasesUser(body.pageModel as never, body.focus),
        maxTokens: 3072,
      });
      res.json({
        artifactId: artifactId(),
        type: 'test_cases',
        format: 'markdown',
        content: stripFences(text),
      });
    }),
  );

  // --- POST /api/generate/bug-report ---
  app.post(
    '/api/generate/bug-report',
    asyncHandler(async (req, res) => {
      const body = bugReportSchema.parse(req.body);
      const text = await provider.complete({
        system: bugReportSystem(),
        user: bugReportUser(body.session as never, (body.pageModel ?? null) as never, body.userNote),
        maxTokens: 2048,
      });
      res.json({
        artifactId: artifactId(),
        type: 'bug_report',
        format: 'markdown',
        content: stripFences(text),
      });
    }),
  );

  // --- POST /api/generate/playwright (deterministic + optional enrichment) ---
  app.post(
    '/api/generate/playwright',
    asyncHandler(async (req, res) => {
      const body = playwrightSchema.parse(req.body);
      const spec = buildPlaywrightSpec(body.session as unknown as TestSession);

      let content = spec.content;
      if (body.enrich) {
        try {
          content = stripFences(
            await provider.complete({
              system: playwrightEnrichSystem(),
              user: playwrightEnrichUser(spec.content),
              maxTokens: 2048,
            }),
          );
        } catch {
          // Enrichment is best-effort; fall back to the deterministic draft.
          content = spec.content;
        }
      }

      res.json({
        artifactId: artifactId(),
        type: 'playwright_test',
        format: 'typescript',
        filename: spec.filename,
        content,
        selectorWarnings: spec.selectorWarnings,
      });
    }),
  );

  // --- error handling ---
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Invalid request', details: err.flatten() });
      return;
    }
    if (err instanceof LLMError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error({ event: 'server.error', err }, 'unhandled error');
    res.status(500).json({ error: (err as Error).message ?? 'Internal error' });
  });

  return app;
}

type Handler = (req: Request, res: Response) => Promise<void>;
function asyncHandler(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
