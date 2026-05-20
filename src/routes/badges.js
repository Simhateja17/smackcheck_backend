/**
 * /api/badges
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// GET /api/badges — all badges
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin.from('badges').select('*');
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/badges/user?userId=... — badges earned by a user
router.get('/user', requireAuth, async (req, res, next) => {
  try {
    const userId = req.query.userId ?? req.userId;
    const { data, error } = await supabaseAdmin
      .from('user_badges')
      .select('*, badges(*)')
      .eq('user_id', userId);
    if (error) throw error;
    res.json(data.map(ub => ({ ...ub.badges, earned_at: ub.earned_at })));
  } catch (err) { next(err); }
});

// GET /api/badges/has?badgeId=... — check if current user has a badge
router.get('/has', requireAuth, async (req, res, next) => {
  try {
    const { badgeId } = req.query;
    if (!badgeId) return res.status(400).json({ error: 'badgeId required' });
    const { data } = await supabaseAdmin
      .from('user_badges')
      .select('id')
      .eq('user_id', req.userId)
      .eq('badge_id', badgeId)
      .maybeSingle();
    res.json({ has: !!data });
  } catch (err) { next(err); }
});

// POST /api/badges/award — award a badge to the current user
router.post('/award', requireAuth, async (req, res, next) => {
  try {
    const { badge_id } = req.body;
    if (!badge_id) return res.status(400).json({ error: 'badge_id required' });
    const { error } = await supabaseAdmin
      .from('user_badges')
      .insert({ id: uuidv4(), user_id: req.userId, badge_id, earned_at: new Date().toISOString() });
    if (error && error.code !== '23505') throw error; // ignore duplicate
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
