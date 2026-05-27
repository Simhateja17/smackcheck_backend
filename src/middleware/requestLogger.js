import { randomUUID } from 'node:crypto';

const shouldLogRequests = process.env.NODE_ENV !== 'test';

const redactHeaders = (headers) => {
  const redacted = { ...headers };

  if (redacted.authorization) redacted.authorization = '[redacted]';
  if (redacted.cookie) redacted.cookie = '[redacted]';

  return redacted;
};

export const requestLogger = (req, res, next) => {
  if (!shouldLogRequests) return next();

  const startedAt = Date.now();
  const incomingRequestId = req.headers['x-request-id'];
  const requestId = Array.isArray(incomingRequestId)
    ? incomingRequestId[0]
    : incomingRequestId ?? randomUUID();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  console.log('[Request:start]', {
    requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    headers: redactHeaders(req.headers),
  });

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'log';

    console[level]('[Request:end]', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
      userId: req.userId,
    });
  });

  next();
};
