import winston from 'winston';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'migration-worker' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          let msg = `${timestamp} [${level}] ${message}`;
          if (Object.keys(meta).length > 0 && meta.service !== 'migration-worker') {
            msg += ` ${JSON.stringify(meta)}`;
          }
          return msg;
        })
      ),
    }),
  ],
});

// If we're not in production, also log to file
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.File({
      filename: 'error.log',
      level: 'error',
    })
  );
  logger.add(
    new winston.transports.File({
      filename: 'combined.log',
    })
  );
}
