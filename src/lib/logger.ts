import pino from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  // Without an error serializer, pino renders an Error passed as `{ error }` /
  // `{ err }` as an empty `{}` (its message/stack are non-enumerable), which made
  // failed platform calls log as `error:{}` — useless for debugging. Serialize
  // both conventional keys so the message + stack always come through.
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export function createLogger(context: string) {
  return logger.child({ context });
}
