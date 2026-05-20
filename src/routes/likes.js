/**
 * /api/likes
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { createNotification, profileDisplayName } from '../utils/notifications.js';

const router = Router();

// POST /api/likes/toggle — toggle like on a rating
router.post('/toggle', requireAuth, async (req, res, next) => {
  try {
    const { rating_id } = req.body;
    if (!rating_id) return res.status(400).json({ error: 'rating_id required' });

    const { data: existing } = await supabaseAdmin
      .from('likes')
      .select('id')
      .eq('user_id', req.userId)
      .eq('rating_id', rating_id)
      .maybeSingle();

    let liked;
    if (existing) {
      await supabaseAdmin.from('likes').delete().eq('id', existing.id);
      await supabaseAdmin.from('ratings')
        .update({ likes_count: supabaseAdmin.rpc('decrement', { x: 1 }) })
        .eq('id', rating_id);
      // Direct update approach (more reliable)
      const { data: r } = await supabaseAdmin.from('ratings').select('likes_count').eq('id', rating_id).single();
      await supabaseAdmin.from('ratings').update({ likes_count: Math.max(0, (r?.likes_count ?? 1) - 1) }).eq('id', rating_id);
      liked = false;
    } else {
      await supabaseAdmin.from('likes').insert({ id: uuidv4(), user_id: req.userId, rating_id });
      const { data: r } = await supabaseAdmin.from('ratings').select('likes_count').eq('id', rating_id).single();
      await supabaseAdmin.from('ratings').update({ likes_count: (r?.likes_count ?? 0) + 1 }).eq('id', rating_id);
      notifyForLike(rating_id, req.userId).catch(console.error);
      liked = true;
    }

    res.json({ liked });
  } catch (err) { next(err); }
});

// GET /api/likes/check?ratingId=... — has current user liked this rating?
router.get('/check', requireAuth, async (req, res, next) => {
  try {
    const { ratingId } = req.query;
    if (!ratingId) return res.status(400).json({ error: 'ratingId required' });
    const { data } = await supabaseAdmin
      .from('likes')
      .select('id')
      .eq('user_id', req.userId)
      .eq('rating_id', ratingId)
      .maybeSingle();
    res.json({ liked: !!data });
  } catch (err) { next(err); }
});

export default router;

async function notifyForLike(ratingId, actorUserId) {
  const { data: rating } = await supabaseAdmin
    .from('ratings')
    .select('user_id, dish_id, dishes(name)')
    .eq('id', ratingId)
    .maybeSingle();

  if (!rating?.user_id || rating.user_id === actorUserId) return;

  const actorName = await profileDisplayName(supabaseAdmin, actorUserId);
  const dishName = rating.dishes?.name || 'your dish';
  await createNotification(supabaseAdmin, {
    userId: rating.user_id,
    eventType: 'review_liked',
    title: 'Review Liked',
    body: `${actorName} liked your review of ${dishName}.`,
    data: { ratingId, dishName, screen: 'SocialFeed' },
  });
}
