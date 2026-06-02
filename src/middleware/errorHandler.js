export const errorHandler = (err, req, res, _next) => {
  const status = err.status ?? 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message ?? 'Internal server error';

  if (status === 500) {
    console.error('[ERROR]', err);
  }

  res.status(status).json({ error: message });
};
