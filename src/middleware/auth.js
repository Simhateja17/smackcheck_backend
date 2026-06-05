import { supabaseAdmin } from '../config/supabase.js';
import { isAdminUser } from '../utils/notifications.js';

const shouldLogAuth = process.env.NODE_ENV !== 'test';

/**
 * Verifies the Supabase JWT from the Authorization: Bearer <token> header.
 * Attaches req.userId (string) on success.
 */
export const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    if (shouldLogAuth) {
      console.warn('[Auth] missing bearer token', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
      });
    }
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = header.slice(7);
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) {
      if (shouldLogAuth) {
        console.warn('[Auth] invalid or expired token', {
          requestId: req.requestId,
          method: req.method,
          path: req.originalUrl,
          reason: error?.message,
        });
      }
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.userId = user.id;
    if (shouldLogAuth) {
      console.log('[Auth] authenticated request', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        userId: req.userId,
      });
    }
    next();
  } catch (error) {
    if (shouldLogAuth) {
      console.error('[Auth] authentication failed', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        message: error.message,
      });
    }
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

/**
 * Verifies the request is from a signed-in admin.
 * This is the trust boundary for every /api/admin route.
 */
export const requireAdmin = [
  requireAuth,
  async (req, res, next) => {
    try {
      const isAdmin = await isAdminUser(supabaseAdmin, req.userId);
      if (!isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      next();
    } catch (error) {
      next(error);
    }
  },
];
