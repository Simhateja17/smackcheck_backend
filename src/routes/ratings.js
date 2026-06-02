/**
 * /api/ratings
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/ratings?dishId=...&restaurantId=...
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { dishId, restaurantId, userId, limit = '20', offset = '0' } = req.query;
    let q = supabaseAdmin
      .from('ratings')
      .select('*, profiles(id, name, username, profile_photo_url), dishes(id, name), restaurants(id, name)')
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (dishId) q = q.eq('dish_id', dishId);
    if (restaurantId) q = q.eq('restaurant_id', restaurantId);
    if (userId) q = q.eq('user_id', userId);

    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/ratings/feed?limit=20&offset=0 — global feed
router.get('/feed', requireAuth, async (req, res, next) => {
  try {
    const { limit = '20', offset = '0' } = req.query;
    const { data, error } = await supabaseAdmin
      .from('ratings')
      .select('*, profiles(id, name, username, profile_photo_url), dishes(id, name), restaurants(id, name, city)')
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/ratings/trending?limit=20&offset=0
router.get('/trending', requireAuth, async (req, res, next) => {
  try {
    const { limit = '20', offset = '0' } = req.query;
    const { data, error } = await supabaseAdmin
      .from('ratings')
      .select('*, profiles(id, name, username, profile_photo_url), dishes(id, name), restaurants(id, name, city)')
      .order('likes_count', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/ratings/highest-rated?limit=20&offset=0
router.get('/highest-rated', requireAuth, async (req, res, next) => {
  try {
    const { limit = '20', offset = '0', restaurantIds } = req.query;
    let q = supabaseAdmin
      .from('ratings')
      .select('*, profiles(id, name, username, profile_photo_url), dishes(id, name), restaurants(id, name, city)')
      .gte('rating', 4.0)
      .order('rating', { ascending: false })
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (restaurantIds) q = q.in('restaurant_id', restaurantIds.split(',').filter(Boolean));

    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/ratings/count-today?userId=... — ratings by user in last 24h
router.get('/count-today', requireAuth, async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 86400000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('ratings')
      .select('id')
      .eq('user_id', req.userId)
      .gte('created_at', since);
    if (error) throw error;
    res.json({ count: data.length });
  } catch (err) { next(err); }
});

// GET /api/ratings/unique-restaurants — count of unique restaurants rated by current user
router.get('/unique-restaurants', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('ratings')
      .select('restaurant_id')
      .eq('user_id', req.userId);
    if (error) throw error;
    const unique = new Set(data.map(r => r.restaurant_id)).size;
    res.json({ count: unique });
  } catch (err) { next(err); }
});

// GET /api/ratings/with-photos-count — count of ratings with photos by current user
router.get('/with-photos-count', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('ratings')
      .select('id')
      .eq('user_id', req.userId)
      .not('image_url', 'is', null);
    if (error) throw error;
    res.json({ count: data.length });
  } catch (err) { next(err); }
});

// GET /api/ratings/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('ratings')
      .select('*, profiles(id, name, username, profile_photo_url), dishes(id, name), restaurants(id, name, city)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Rating not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/ratings — submit a rating
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { dish_id, restaurant_id, rating, comment, image_url, latitude, longitude, price } = req.body;
    if (!dish_id || !restaurant_id || rating == null) {
      return res.status(400).json({ error: 'dish_id, restaurant_id, and rating are required' });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be between 1 and 5' });
    }

    const id = uuidv4();
    const { data, error } = await supabaseAdmin
      .from('ratings')
      .insert({
        id,
        user_id: req.userId,
        dish_id,
        restaurant_id,
        rating: parseFloat(rating),
        comment: comment ?? '',
        image_url: image_url ?? null,
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        price: price ?? null,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;

    // Update dish + restaurant counters asynchronously (fire and forget)
    updateAverages(dish_id, restaurant_id).catch(console.error);

    res.status(201).json(data);
  } catch (err) { next(err); }
});

async function updateAverages(dishId, restaurantId) {
  // Dish average
  const { data: dRatings } = await supabaseAdmin
    .from('ratings').select('rating').eq('dish_id', dishId);
  if (dRatings?.length) {
    const avg = dRatings.reduce((s, r) => s + r.rating, 0) / dRatings.length;
    await supabaseAdmin.from('dishes').update({ average_rating: avg, review_count: dRatings.length }).eq('id', dishId);
  }
  // Restaurant average
  const { data: rRatings } = await supabaseAdmin
    .from('ratings').select('rating').eq('restaurant_id', restaurantId);
  if (rRatings?.length) {
    const avg = rRatings.reduce((s, r) => s + r.rating, 0) / rRatings.length;
    await supabaseAdmin.from('restaurants').update({ average_rating: avg, review_count: rRatings.length }).eq('id', restaurantId);
  }
}

export default router;
