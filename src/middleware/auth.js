import { supabaseAdmin } from '../config/supabase.js';

/**
 * Verifies the Supabase JWT from the Authorization: Bearer <token> header.
 * Attaches req.userId (string) on success.
 */
export const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = header.slice(7);
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.userId = user.id;
    next();
  } catch {
    return res.status(401).json({ error: 'Authentication failed' });
  }
};
