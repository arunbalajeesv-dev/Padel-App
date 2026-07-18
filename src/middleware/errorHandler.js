export function notFound(req, res) {
  res.status(404).json({ error: 'Not Found' });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export function errorHandler(err, req, res, next) {
  const status = err.status || 500;

  // A 500 is a bug. Log it — the response deliberately says nothing useful, so
  // this is the only record that it happened.
  if (status === 500) {
    console.error(`500 ${req.method} ${req.originalUrl}:`, err);
  }

  res.status(status).json({
    error: status === 500 ? 'Internal Server Error' : err.message,
  });
}
