import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from '../logging/logger.js';
import { runWithRequestId } from '../logging/request-context.js';

/**
 * Assign each request a correlation id (honoring an inbound `x-request-id`),
 * echo it on the response, and run the rest of the chain inside the
 * request-context ALS so LLM traces share the id. Emits one access line per
 * request at `debug`.
 */
export function requestIdMiddleware(logger: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers['x-request-id'];
    const requestId = (Array.isArray(header) ? header[0] : header) || randomUUID();
    res.setHeader('x-request-id', requestId);

    const start = performance.now();
    res.on('finish', () => {
      logger.debug(
        {
          event: 'http.request',
          requestId,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          ms: Math.round(performance.now() - start),
        },
        'http request',
      );
    });

    runWithRequestId(requestId, () => next());
  };
}
