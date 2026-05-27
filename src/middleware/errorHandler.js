export const errorHandler = (err, req, res, _next) => {
  const status = err.status ?? 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message ?? 'Internal server error';

  if (process.env.NODE_ENV !== 'test') {
    const logPayload = {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status,
      userId: req.userId,
      message: err.message,
      stack: status === 500 ? err.stack : undefined,
    };

    if (status >= 500) {
      console.error('[Error]', logPayload);
    } else {
      console.warn('[Error]', logPayload);
    }
  }

  res.status(status).json({ error: message });
};
