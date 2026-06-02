/**
 * /api/saves — restaurant saves
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/saves — get saved restaurant IDs for current user
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('restaurant_saves')
      .select('restaurant_id')
      .eq('user_id', req.userId);
    if (error) throw error;
    res.json(data.map(r => r.restaurant_id));
  } catch (err) { next(err); }
});

// POST /api/saves/toggle — save or unsave a restaurant
router.post('/toggle', requireAuth, async (req, res, next) => {
  try {
    const { restaurant_id } = req.body;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });

    const { data: existing } = await supabaseAdmin
      .from('restaurant_saves')
      .select('id')
      .eq('user_id', req.userId)
      .eq('restaurant_id', restaurant_id)
      .maybeSingle();

    let saved;
    if (existing) {
      await supabaseAdmin.from('restaurant_saves').delete().eq('id', existing.id);
      saved = false;
    } else {
      await supabaseAdmin.from('restaurant_saves').insert({ user_id: req.userId, restaurant_id });
      saved = true;
    }
    res.json({ saved });
  } catch (err) { next(err); }
});

export default router;
