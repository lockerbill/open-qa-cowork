import { describe, it, expect } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger, parseLogLevel } from './logger.js';
import { runWithRequestId } from './request-context.js';

/** A pino destination that captures each emitted line as a parsed object. */
function capture(): { lines: Record<string, unknown>[]; stream: DestinationStream } {
  const lines: Record<string, unknown>[] = [];
  return { lines, stream: { write: (msg: string) => void lines.push(JSON.parse(msg)) } };
}

describe('parseLogLevel', () => {
  it('accepts valid levels', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('error')).toBe('error');
  });

  it('defaults unknown or missing values to info', () => {
    expect(parseLogLevel('bogus')).toBe('info');
    expect(parseLogLevel(undefined)).toBe('info');
  });
});

describe('createLogger level filtering', () => {
  it('suppresses info and debug at level warn', () => {
    const { lines, stream } = capture();
    const logger = createLogger('warn', stream);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((l) => l.msg)).toEqual(['w', 'e']);
  });

  it('emits every level at debug', () => {
    const { lines, stream } = capture();
    const logger = createLogger('debug', stream);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(lines.map((l) => l.msg)).toEqual(['d', 'i', 'w', 'e']);
  });
});

describe('createLogger requestId injection', () => {
  it('attaches the requestId inside a request scope', () => {
    const { lines, stream } = capture();
    const logger = createLogger('info', stream);
    runWithRequestId('req_x', () => logger.info('scoped'));
    expect(lines[0].requestId).toBe('req_x');
  });

  it('omits requestId outside a request scope', () => {
    const { lines, stream } = capture();
    const logger = createLogger('info', stream);
    logger.info('unscoped');
    expect(lines[0]).not.toHaveProperty('requestId');
  });
});
