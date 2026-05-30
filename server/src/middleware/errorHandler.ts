import type { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, next: NextFunction) {
  console.error('[Error]', err.message);

  if (res.headersSent) return next(err);

  const status = (err as any).status ?? 500;
  res.status(status).json({
    error: {
      message: err.message,
      type: status >= 400 && status < 500 ? 'invalid_request_error' : 'server_error',
      param: null,
      code: err.name ?? 'server_error',
    },
  });
}
