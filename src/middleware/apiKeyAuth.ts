import { Request, Response, NextFunction } from 'express';

/**
 * API Key Authentication Middleware
 *
 * Validates API key from request headers against the configured API_KEY
 *
 * Expected header format:
 *   X-API-Key: your-api-key-here
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.API_KEY;

  // Skip authentication in development if API_KEY is not set
  if (!apiKey && process.env.NODE_ENV === 'development') {
    console.warn('[Auth] API_KEY not set - skipping authentication (development mode)');
    return next();
  }

  if (!apiKey) {
    console.error('[Auth] API_KEY not configured in environment variables');
    res.status(500).json({
      error: 'Server configuration error',
      message: 'API authentication is not properly configured'
    });
    return;
  }

  // Get API key from header
  const clientApiKey = req.headers['x-api-key'] as string;

  if (!clientApiKey) {
    console.warn('[Auth] Missing API key in request');
    res.status(401).json({
      error: 'Unauthorized',
      message: 'API key is required. Please provide X-API-Key header.'
    });
    return;
  }

  // Validate API key
  if (clientApiKey !== apiKey) {
    console.warn('[Auth] Invalid API key attempt');
    res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key'
    });
    return;
  }

  // Authentication successful
  next();
}

/**
 * Optional API Key Authentication Middleware
 *
 * Similar to apiKeyAuth but allows requests without API key
 * Useful for public endpoints that optionally support authentication
 */
export function optionalApiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.API_KEY;
  const clientApiKey = req.headers['x-api-key'] as string;

  // No API key provided - allow request
  if (!clientApiKey) {
    return next();
  }

  // API key provided - validate it
  if (!apiKey) {
    console.error('[Auth] API_KEY not configured but client provided key');
    res.status(500).json({
      error: 'Server configuration error'
    });
    return;
  }

  if (clientApiKey !== apiKey) {
    console.warn('[Auth] Invalid API key attempt (optional auth)');
    res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key'
    });
    return;
  }

  // Authentication successful
  next();
}
