/**
 * /api/notifications
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { createNotification, isAdminUser } from '../utils/notifications.js';

const router = Router();

// GET /api/notifications?limit=50&offset=0&unreadOnly=false
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { limit = '50', offset = '0', unreadOnly = 'false' } = req.query;
    let q = supabaseAdmin
      .from('notifications')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    if (unreadOnly === 'true') q = q.eq('is_read', false);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/notifications/unread-count
router.get('/unread-count', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .select('id')
      .eq('user_id', req.userId)
      .eq('is_read', false);
    if (error) throw error;
    res.json({ count: data.length });
  } catch (err) { next(err); }
});

// POST /api/notifications — create notification (internal use / admin)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { user_id, event_type, title, body, data: notifData } = req.body;
    if (!user_id || !event_type || !title || !body) {
      return res.status(400).json({ error: 'user_id, event_type, title, body required' });
    }
    if (user_id !== req.userId && !(await isAdminUser(supabaseAdmin, req.userId))) {
      return res.status(403).json({ error: 'Cannot create notifications for other users' });
    }

    const notification = await createNotification(supabaseAdmin, {
      userId: user_id,
      eventType: event_type,
      title,
      body,
      data: notifData ?? {},
    });

    res.status(201).json(notification);
  } catch (err) { next(err); }
});

// PATCH /api/notifications/:id/read — mark one as read
router.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/notifications/read-all — mark all as read
router.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.userId)
      .eq('is_read', false);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
