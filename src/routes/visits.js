/**
 * /api/visits — restaurant visits (geofence tracking)
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/visits?restaurantId=...
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { restaurantId } = req.query;
    let q = supabaseAdmin
      .from('restaurant_visits')
      .select('*')
      .eq('user_id', req.userId)
      .order('entered_at', { ascending: false });
    if (restaurantId) q = q.eq('restaurant_id', restaurantId);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/visits — track a visit
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { restaurant_id, latitude, longitude, exited_at, duration_minutes } = req.body;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });
    const { data, error } = await supabaseAdmin
      .from('restaurant_visits')
      .insert({
        user_id: req.userId,
        restaurant_id,
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        exited_at: exited_at ?? null,
        duration_minutes: duration_minutes ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// PATCH /api/visits/end — close latest open visit for current user
router.patch('/end', requireAuth, async (req, res, next) => {
  try {
    const { restaurant_id, exited_at, duration_minutes } = req.body;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });

    const { data: openVisit, error: findError } = await supabaseAdmin
      .from('restaurant_visits')
      .select('id')
      .eq('user_id', req.userId)
      .eq('restaurant_id', restaurant_id)
      .is('exited_at', null)
      .order('entered_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (findError) throw findError;
    if (!openVisit) return res.json({ success: true, updated: false });

    const { error } = await supabaseAdmin
      .from('restaurant_visits')
      .update({
        exited_at: exited_at ?? new Date().toISOString(),
        duration_minutes: duration_minutes ?? null,
      })
      .eq('id', openVisit.id);
    if (error) throw error;

    res.json({ success: true, updated: true });
  } catch (err) { next(err); }
});

export default router;
