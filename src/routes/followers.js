/**
 * /api/followers
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { createNotification, profileDisplayName } from '../utils/notifications.js';

const router = Router();

// GET /api/followers?userId=... — followers of a user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.query.userId ?? req.userId;
    const { data, error } = await supabaseAdmin
      .from('followers')
      .select('follower_id, created_at, profiles!followers_follower_id_fkey(id, name, username, profile_photo_url)')
      .eq('following_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/followers/following?userId=... — who a user follows
router.get('/following', requireAuth, async (req, res, next) => {
  try {
    const userId = req.query.userId ?? req.userId;
    const { data, error } = await supabaseAdmin
      .from('followers')
      .select('following_id, created_at, profiles!followers_following_id_fkey(id, name, username, profile_photo_url)')
      .eq('follower_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/followers/is-following?targetId=...
router.get('/is-following', requireAuth, async (req, res, next) => {
  try {
    const { targetId } = req.query;
    if (!targetId) return res.status(400).json({ error: 'targetId required' });
    const { data } = await supabaseAdmin
      .from('followers')
      .select('id')
      .eq('follower_id', req.userId)
      .eq('following_id', targetId)
      .maybeSingle();
    res.json({ is_following: !!data, following: !!data });
  } catch (err) { next(err); }
});

// POST /api/followers — follow a user
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { target_user_id } = req.body;
    if (!target_user_id) return res.status(400).json({ error: 'target_user_id required' });
    if (target_user_id === req.userId) return res.status(400).json({ error: 'Cannot follow yourself' });

    const { error } = await supabaseAdmin
      .from('followers')
      .insert({ follower_id: req.userId, following_id: target_user_id });
    if (error && error.code !== '23505') throw error; // ignore duplicate

    // Update counters
    await Promise.all([
      supabaseAdmin.rpc('increment_counter', { tbl: 'profiles', col: 'following_count', row_id: req.userId }).catch(() =>
        incrementCounter('profiles', 'following_count', req.userId)),
      supabaseAdmin.rpc('increment_counter', { tbl: 'profiles', col: 'followers_count', row_id: target_user_id }).catch(() =>
        incrementCounter('profiles', 'followers_count', target_user_id)),
    ]);

    const followerName = await profileDisplayName(supabaseAdmin, req.userId);
    createNotification(supabaseAdmin, {
      userId: target_user_id,
      eventType: 'new_follower',
      title: 'New Follower',
      body: `${followerName} started following you.`,
      data: { follower_id: req.userId, screen: 'UserProfile' },
    }).catch(console.error);

    res.status(201).json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/followers/:targetUserId — unfollow
router.delete('/:targetUserId', requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('followers')
      .delete()
      .eq('follower_id', req.userId)
      .eq('following_id', req.params.targetUserId);
    if (error) throw error;

    // Update counters
    await Promise.all([
      decrementCounter('profiles', 'following_count', req.userId),
      decrementCounter('profiles', 'followers_count', req.params.targetUserId),
    ]);

    res.status(204).send();
  } catch (err) { next(err); }
});

async function incrementCounter(table, col, id) {
  const { data } = await supabaseAdmin.from(table).select(col).eq('id', id).single();
  if (data) await supabaseAdmin.from(table).update({ [col]: (data[col] ?? 0) + 1 }).eq('id', id);
}
async function decrementCounter(table, col, id) {
  const { data } = await supabaseAdmin.from(table).select(col).eq('id', id).single();
  if (data) await supabaseAdmin.from(table).update({ [col]: Math.max(0, (data[col] ?? 1) - 1) }).eq('id', id);
}

export default router;
