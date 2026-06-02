/**
 * /api/moderation — reports and blocks
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// POST /api/moderation/report — report content
router.post('/report', requireAuth, async (req, res, next) => {
  try {
    const { target_type, target_id, reason, details } = req.body;
    const validTypes = ['rating', 'comment', 'profile', 'story', 'user'];
    if (!target_type || !validTypes.includes(target_type)) {
      return res.status(400).json({ error: `target_type must be one of: ${validTypes.join(', ')}` });
    }
    if (!target_id) return res.status(400).json({ error: 'target_id required' });
    if (!reason || reason.trim().length < 3 || reason.trim().length > 80) {
      return res.status(400).json({ error: 'reason must be 3-80 characters' });
    }
    if (details && details.length > 2000) {
      return res.status(400).json({ error: 'details must be max 2000 characters' });
    }

    const { data, error } = await supabaseAdmin.from('reports').insert({
      reporter_id: req.userId,
      target_type,
      target_id,
      reason: reason.trim(),
      details: details ?? null,
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// POST /api/moderation/block — block a user
router.post('/block', requireAuth, async (req, res, next) => {
  try {
    const { blocked_user_id, reason } = req.body;
    if (!blocked_user_id) return res.status(400).json({ error: 'blocked_user_id required' });
    if (blocked_user_id === req.userId) return res.status(400).json({ error: 'Cannot block yourself' });

    const { error } = await supabaseAdmin.from('blocks').insert({
      blocker_id: req.userId,
      blocked_id: blocked_user_id,
      reason: reason ?? null,
    });
    if (error && error.code !== '23505') throw error;

    // Also unfollow in both directions
    await Promise.all([
      supabaseAdmin.from('followers').delete().eq('follower_id', req.userId).eq('following_id', blocked_user_id),
      supabaseAdmin.from('followers').delete().eq('follower_id', blocked_user_id).eq('following_id', req.userId),
    ]);

    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/moderation/blocked — list of blocked user IDs for current user
router.get('/blocked', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('blocks')
      .select('blocked_id')
      .eq('blocker_id', req.userId);
    if (error) throw error;
    res.json(data.map(b => b.blocked_id));
  } catch (err) { next(err); }
});

export default router;
