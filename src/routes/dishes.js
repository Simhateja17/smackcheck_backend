/**
 * /api/dishes
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/dishes/top?limit=10 — top-rated dishes
router.get('/top', requireAuth, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit ?? '10', 10);
    const { data: ratings, error } = await supabaseAdmin
      .from('ratings')
      .select('dish_id, rating')
      .order('rating', { ascending: false })
      .limit(200);
    if (error) throw error;

    // Average by dish_id
    const map = new Map();
    for (const r of ratings) {
      if (!map.has(r.dish_id)) map.set(r.dish_id, { sum: 0, count: 0 });
      const e = map.get(r.dish_id);
      e.sum += r.rating; e.count++;
    }
    const sorted = [...map.entries()]
      .map(([id, { sum, count }]) => ({ id, avg: sum / count }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, limit);

    if (!sorted.length) return res.json([]);

    const { data: dishes, error: dErr } = await supabaseAdmin
      .from('dishes')
      .select('*')
      .in('id', sorted.map(s => s.id));
    if (dErr) throw dErr;
    res.json(dishes);
  } catch (err) { next(err); }
});

// GET /api/dishes/top-for-restaurants?ids=id1,id2&limit=10
router.get('/top-for-restaurants', requireAuth, async (req, res, next) => {
  try {
    const ids = (req.query.ids ?? '').split(',').filter(Boolean);
    const limit = parseInt(req.query.limit ?? '10', 10);
    if (!ids.length) return res.json([]);

    const { data, error } = await supabaseAdmin
      .from('ratings')
      .select('dish_id, rating')
      .in('restaurant_id', ids)
      .order('rating', { ascending: false })
      .limit(200);
    if (error) throw error;

    const map = new Map();
    for (const r of data) {
      if (!map.has(r.dish_id)) map.set(r.dish_id, { sum: 0, count: 0 });
      const e = map.get(r.dish_id);
      e.sum += r.rating; e.count++;
    }
    const dishIds = [...map.entries()]
      .sort((a, b) => (b[1].sum / b[1].count) - (a[1].sum / a[1].count))
      .slice(0, limit)
      .map(([id]) => id);

    if (!dishIds.length) return res.json([]);
    const { data: dishes, error: dErr } = await supabaseAdmin
      .from('dishes')
      .select('*')
      .in('id', dishIds);
    if (dErr) throw dErr;
    res.json(dishes);
  } catch (err) { next(err); }
});

// GET /api/dishes?restaurantId=...
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { restaurantId, restaurantIds } = req.query;
    let q = supabaseAdmin.from('dishes').select('*');
    if (restaurantId) q = q.eq('restaurant_id', restaurantId);
    else if (restaurantIds) q = q.in('restaurant_id', restaurantIds.split(',').filter(Boolean));
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/dishes/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('dishes')
      .select('*, restaurants(*)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Dish not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/dishes — create or get existing (deduplication)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, restaurant_id, image_url, restaurant_name } = req.body;
    if (!name || !restaurant_id) return res.status(400).json({ error: 'name and restaurant_id required' });

    // Check if dish already exists
    const { data: existing } = await supabaseAdmin
      .from('dishes')
      .select('*')
      .eq('name', name)
      .eq('restaurant_id', restaurant_id)
      .maybeSingle();
    if (existing) {
      // Backfill image_url if missing
      if (image_url && !existing.image_url) {
        await supabaseAdmin.from('dishes').update({ image_url }).eq('id', existing.id);
        existing.image_url = image_url;
      }
      return res.json(existing);
    }

    const dish = {
      id: uuidv4(),
      name,
      restaurant_id,
      image_url: image_url ?? null,
    };
    const { data, error } = await supabaseAdmin
      .from('dishes')
      .insert(dish)
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

export default router;
