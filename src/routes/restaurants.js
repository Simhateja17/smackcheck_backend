/**
 * /api/restaurants
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/restaurants — list all or search
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { query, cuisines, city, minRating, restaurantsOnly, limit = '50', offset = '0' } = req.query;
    let q = supabaseAdmin.from('restaurants').select('*');

    if (query) {
      q = q.or(`name.ilike.%${query}%,cuisine.ilike.%${query}%,city.ilike.%${query}%`);
    }
    if (cuisines) {
      const list = cuisines.split(',').map(c => c.trim()).filter(Boolean);
      if (list.length) q = q.in('cuisine', list);
    }
    if (city) q = q.ilike('city', `%${city}%`);
    if (minRating) q = q.gte('average_rating', parseFloat(minRating));
    if (restaurantsOnly === 'true') {
      q = q.or(`category.ilike.%restaurant%,category.ilike.%cafe%,category.ilike.%coffee%`);
    }
    const start = parseInt(offset, 10);
    const count = parseInt(limit, 10);
    q = q
      .order('average_rating', { ascending: false })
      .range(start, start + count - 1);

    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/restaurants/cuisines — distinct cuisine list
router.get('/cuisines', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .select('cuisine');
    if (error) throw error;
    const cuisines = [...new Set(data.map(r => r.cuisine).filter(Boolean))].sort();
    res.json(cuisines);
  } catch (err) { next(err); }
});

// GET /api/restaurants/cities — distinct city list
router.get('/cities', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .select('city');
    if (error) throw error;
    const cities = [...new Set(data.map(r => r.city).filter(Boolean))].sort();
    res.json(cities);
  } catch (err) { next(err); }
});

// GET /api/restaurants/by-city?city=...
router.get('/by-city', requireAuth, async (req, res, next) => {
  try {
    const { city } = req.query;
    if (!city) return res.status(400).json({ error: 'city required' });
    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .select('*')
      .ilike('city', `%${city}%`)
      .order('average_rating', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/restaurants/by-place-id?placeId=...
router.get('/by-place-id', requireAuth, async (req, res, next) => {
  try {
    const { placeId } = req.query;
    if (!placeId) return res.status(400).json({ error: 'placeId required' });
    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .select('*')
      .eq('google_place_id', placeId)
      .maybeSingle();
    if (error) throw error;
    res.json(data ?? null);
  } catch (err) { next(err); }
});

// GET /api/restaurants/:id
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/restaurants — upsert (ensure exists)
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { id, name, city, cuisine, latitude, longitude, google_place_id, image_urls, photo_urls, category } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const record = {
      id: id ?? undefined,
      name,
      city: city ?? '',
      cuisine: cuisine ?? '',
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      google_place_id: google_place_id ?? null,
      image_urls: image_urls ?? [],
      photo_urls: photo_urls ?? [],
      category: category ?? 'restaurant',
    };

    // Upsert on google_place_id if provided, else on id
    const conflict = google_place_id ? 'google_place_id' : 'id';
    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .upsert(record, { onConflict: conflict, ignoreDuplicates: false })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

export default router;
