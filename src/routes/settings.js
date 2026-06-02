/**
 * /api/settings — privacy & notification settings
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── Privacy settings ─────────────────────────────────────────────────────────

// GET /api/settings/privacy
router.get('/privacy', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_privacy_settings')
      .select('*')
      .eq('user_id', req.userId)
      .maybeSingle();
    if (error) throw error;
    // Return defaults if no row
    res.json(data ?? {
      user_id: req.userId,
      profile_visibility: 'PUBLIC',
      show_email: false,
      show_location: true,
      allow_tagging: true,
      data_collection: true,
      share_exact_location: false,
      share_approximate_location: true,
    });
  } catch (err) { next(err); }
});

// PUT /api/settings/privacy
router.put('/privacy', requireAuth, async (req, res, next) => {
  try {
    const allowed = ['profile_visibility', 'show_email', 'show_location', 'allow_tagging',
      'data_collection', 'share_exact_location', 'share_approximate_location'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    const { data, error } = await supabaseAdmin
      .from('user_privacy_settings')
      .upsert({ user_id: req.userId, ...updates, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// ── Notification settings ─────────────────────────────────────────────────────

// GET /api/settings/notifications
router.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_notification_settings')
      .select('*')
      .eq('user_id', req.userId)
      .maybeSingle();
    if (error) throw error;
    res.json(data ?? {
      user_id: req.userId,
      push_enabled: true,
      email_enabled: true,
      new_follower_notif: true,
      new_like_notif: true,
      new_comment_notif: true,
      weekly_digest: true,
      achievement_notif: true,
    });
  } catch (err) { next(err); }
});

// PUT /api/settings/notifications
router.put('/notifications', requireAuth, async (req, res, next) => {
  try {
    const allowed = ['push_enabled', 'email_enabled', 'new_follower_notif', 'new_like_notif',
      'new_comment_notif', 'weekly_digest', 'achievement_notif', 'digest_frequency',
      'quiet_hours_start', 'quiet_hours_end'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    const { data, error } = await supabaseAdmin
      .from('user_notification_settings')
      .upsert({ user_id: req.userId, ...updates, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

export default router;
