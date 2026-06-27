import pino, { type DestinationStream, type Logger } from 'pino';
import pretty from 'pino-pretty';
import { getRequestId } from './request-context.js';

export type { Logger };
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

/** Coerce an arbitrary LOG_LEVEL string to a valid level, defaulting to `info`. */
export function parseLogLevel(value: string | undefined): LogLevel {
  return value !== undefined && (LEVELS as readonly string[]).includes(value)
    ? (value as LogLevel)
    : 'info';
}

/**
 * Build a pino logger. Every line carries the current `requestId` (from the
 * request-context ALS) when one is in scope. By default it writes human-readable
 * plain text via pino-pretty; tests pass a `destination` to capture raw JSON lines.
 */
export function createLogger(level: LogLevel = 'info', destination?: DestinationStream): Logger {
  const stream =
    destination ??
    pretty({ colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' });
  return pino(
    {
      level,
      mixin() {
        const requestId = getRequestId();
        return requestId ? { requestId } : {};
      },
    },
    stream,
  );
}

let singleton: Logger | undefined;

/** Lazily-built process-wide logger (level from `LOG_LEVEL`); the default for wiring. */
export function defaultLogger(): Logger {
  return (singleton ??= createLogger(parseLogLevel(process.env.LOG_LEVEL)));
}
