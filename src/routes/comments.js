/**
 * /api/comments
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { createNotification, profileDisplayName } from '../utils/notifications.js';

const router = Router();

// GET /api/comments?ratingId=...
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { ratingId } = req.query;
    if (!ratingId) return res.status(400).json({ error: 'ratingId required' });
    const { data, error } = await supabaseAdmin
      .from('comments')
      .select('*, profiles(id, name, username, profile_photo_url)')
      .eq('rating_id', ratingId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    // Build nested tree
    const roots = [];
    const map = new Map(data.map(c => [c.id, { ...c, replies: [] }]));
    for (const c of map.values()) {
      if (c.parent_comment_id) {
        const parent = map.get(c.parent_comment_id);
        if (parent) parent.replies.push(c);
        else roots.push(c);
      } else {
        roots.push(c);
      }
    }
    res.json(roots);
  } catch (err) { next(err); }
});

// GET /api/comments/count?ratingId=...
router.get('/count', requireAuth, async (req, res, next) => {
  try {
    const { ratingId } = req.query;
    if (!ratingId) return res.status(400).json({ error: 'ratingId required' });
    const { data, error } = await supabaseAdmin
      .from('comments')
      .select('id')
      .eq('rating_id', ratingId);
    if (error) throw error;
    res.json({ count: data.length });
  } catch (err) { next(err); }
});

// POST /api/comments — add a comment
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { rating_id, content, parent_comment_id } = req.body;
    if (!rating_id || !content) return res.status(400).json({ error: 'rating_id and content required' });
    const trimmed = content.trim();
    if (trimmed.length < 1 || trimmed.length > 1000) {
      return res.status(400).json({ error: 'content must be 1-1000 characters' });
    }

    const { data, error } = await supabaseAdmin
      .from('comments')
      .insert({
        rating_id,
        user_id: req.userId,
        content: trimmed,
        parent_comment_id: parent_comment_id ?? null,
      })
      .select('*, profiles(id, name, username, profile_photo_url)')
      .single();
    if (error) throw error;

    notifyForComment(rating_id, parent_comment_id, req.userId).catch(console.error);

    res.status(201).json({ ...data, replies: [] });
  } catch (err) { next(err); }
});

// DELETE /api/comments/:id
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('comments')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);
    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;

async function notifyForComment(ratingId, parentCommentId, actorUserId) {
  const actorName = await profileDisplayName(supabaseAdmin, actorUserId);

  if (parentCommentId) {
    const { data: parent } = await supabaseAdmin
      .from('comments')
      .select('user_id')
      .eq('id', parentCommentId)
      .maybeSingle();

    if (parent?.user_id && parent.user_id !== actorUserId) {
      await createNotification(supabaseAdmin, {
        userId: parent.user_id,
        eventType: 'comment_reply',
        title: 'New Reply',
        body: `${actorName} replied to your comment.`,
        data: { ratingId, parentCommentId, screen: 'Comments' },
      });
      return;
    }
  }

  const { data: rating } = await supabaseAdmin
    .from('ratings')
    .select('user_id, dish_id, dishes(name)')
    .eq('id', ratingId)
    .maybeSingle();

  if (!rating?.user_id || rating.user_id === actorUserId) return;

  const dishName = rating.dishes?.name || 'your dish';
  await createNotification(supabaseAdmin, {
    userId: rating.user_id,
    eventType: 'dish_comment',
    title: 'New Comment',
    body: `${actorName} commented on your review of ${dishName}.`,
    data: { ratingId, dishName, screen: 'Comments' },
  });
}
