/**
 * /api/stories
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

function toStoryResponse(story) {
  const profile = story.profiles ?? {};
  return {
    id: story.id,
    user_id: story.user_id,
    image_url: story.image_url,
    created_at: story.created_at,
    expires_at: story.expires_at,
    user_name: profile.name ?? profile.username ?? null,
    user_profile_url: profile.profile_photo_url ?? null,
  };
}

// GET /api/stories — active stories from the current user and followed users
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data: following, error: followingError } = await supabaseAdmin
      .from('followers')
      .select('following_id')
      .eq('follower_id', req.userId);
    if (followingError) throw followingError;

    const visibleUserIds = [req.userId, ...new Set((following ?? []).map(f => f.following_id))];

    const { data, error } = await supabaseAdmin
      .from('stories')
      .select('*, profiles(id, name, username, profile_photo_url)')
      .in('user_id', visibleUserIds)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json((data ?? []).map(toStoryResponse));
  } catch (err) { next(err); }
});

// GET /api/stories/by-user?userId=...
router.get('/by-user', requireAuth, async (req, res, next) => {
  try {
    const userId = req.query.userId ?? req.userId;
    const { data, error } = await supabaseAdmin
      .from('stories')
      .select('*')
      .eq('user_id', userId)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/stories — upload a story
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { image_url } = req.body;
    if (!image_url) return res.status(400).json({ error: 'image_url required' });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('stories')
      .insert({ user_id: req.userId, image_url, expires_at: expiresAt })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// DELETE /api/stories/:id
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('stories')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);
    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
