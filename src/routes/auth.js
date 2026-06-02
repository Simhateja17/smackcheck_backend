/**
 * /api/auth
 * Profile management (Auth itself stays in the mobile Supabase SDK).
 * The backend manages profile rows and push tokens.
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/auth/profile — current user's profile
router.get('/profile', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Profile not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// PUT /api/auth/profile — update profile
router.put('/profile', requireAuth, async (req, res, next) => {
  try {
    const allowed = ['name', 'username', 'bio', 'profile_photo_url', 'last_location',
      'latitude', 'longitude', 'location_sharing_enabled', 'push_token',
      'profile_picture_uploaded'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update(updates)
      .eq('id', req.userId)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/auth/profile — upsert (create or update on sign-up)
router.post('/profile', requireAuth, async (req, res, next) => {
  try {
    const { name, username, email } = req.body;
    const profile = {
      id: req.userId,
      name: name ?? '',
      username: username ?? null,
      email: email ?? '',
      xp: 0,
      level: 1,
      streak_count: 0,
      total_points: 0,
      current_streak: 0,
      longest_streak: 0,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .upsert(profile, { onConflict: 'id' })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// GET /api/auth/check-username?username=foo — availability check
router.get('/check-username', requireAuth, async (req, res, next) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username required' });
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .ilike('username', username)
      .maybeSingle();
    if (error) throw error;
    res.json({ available: !data || data.id === req.userId });
  } catch (err) { next(err); }
});

// DELETE /api/auth/account — delete own account
router.delete('/account', requireAuth, async (req, res, next) => {
  try {
    const { error: profileErr } = await supabaseAdmin
      .from('profiles')
      .delete()
      .eq('id', req.userId);
    if (profileErr) throw profileErr;
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(req.userId);
    if (authErr) throw authErr;
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/auth/users/:id — public profile by id
router.get('/users/:id', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, name, username, bio, profile_photo_url, xp, level, streak_count, total_points, current_streak, longest_streak, created_at, followers_count, following_count, last_location')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// PUT /api/auth/push-token — save or clear push token
router.put('/push-token', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.body; // null to clear
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ push_token: token ?? null, updated_at: new Date().toISOString() })
      .eq('id', req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
