import type { RequestHandler } from 'express';

/**
 * Parses VECTOR_ALLOWED_ORIGINS: a comma-separated list of exact browser origins (for example
 * "https://vector.example.com") that may call this API from another site. Anything that is not a plain
 * http(s) origin is rejected at startup so a typo cannot silently widen access.
 */
export const parseAllowedOrigins = (value: string | undefined): string[] => {
  const origins = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw new Error(`VECTOR_ALLOWED_ORIGINS contains an invalid origin: ${entry}`);
      }
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== entry.replace(/\/+$/, '')) {
        throw new Error(`VECTOR_ALLOWED_ORIGINS entries must be bare http(s) origins: ${entry}`);
      }
      return url.origin;
    });
  return [...new Set(origins)];
};

/**
 * Lets the separately hosted Vector UI call this API from the browser. Requests carry bearer tokens, never
 * cookies, so credentials are not enabled. Origins outside the list get no CORS headers and the browser blocks them.
 */
export const createCors = (allowedOrigins: readonly string[]): RequestHandler => {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (!origin || allowed.size === 0) {
      next();
      return;
    }
    res.append('Vary', 'Origin');
    if (!allowed.has(origin)) {
      next();
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range');
    if (req.method === 'OPTIONS' && req.get('Access-Control-Request-Method')) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', req.get('Access-Control-Request-Headers') ?? 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
};
