import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const rootLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      }
    : {}),
  base: { service: 'settlement-service' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Create a child logger with a trace ID bound to a specific request
export function createRequestLogger(traceId: string) {
  return rootLogger.child({ traceId });
}

export type Logger = ReturnType<typeof createRequestLogger>;
