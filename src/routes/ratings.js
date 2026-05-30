/**
 * /api/ratings
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const RECEIPT_SOURCES = new Set(['camera', 'gallery', 'screenshot']);

function parseRating(value) {
  const rating = Number.parseFloat(value);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return null;
  }
  return rating;
}

function parseOptionalNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanTags(tags) {
  return Array.isArray(tags)
    ? tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 20)
    : [];
}

function cleanReceiptPayload(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 12000);
  return JSON.stringify(value).slice(0, 12000);
}

async function createOrGetDish({ name, restaurantId, imageUrl }) {
  const normalizedName = String(name ?? '').trim();
  if (!normalizedName || !restaurantId) {
    throw Object.assign(new Error('dish name and restaurant_id are required'), { status: 400 });
  }

  const { data: existing, error: findError } = await supabaseAdmin
    .from('dishes')
    .select('*')
    .eq('name', normalizedName)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
  if (findError) throw findError;

  if (existing) {
    if (imageUrl && !existing.image_url) {
      await supabaseAdmin.from('dishes').update({ image_url: imageUrl }).eq('id', existing.id);
      existing.image_url = imageUrl;
    }
    return existing;
  }

  const { data, error } = await supabaseAdmin
    .from('dishes')
    .insert({
      id: uuidv4(),
      name: normalizedName,
      restaurant_id: restaurantId,
      image_url: imageUrl ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

function isOwnReceiptStorageUrl(url, userId) {
  try {
    const parsed = new URL(url);
    const safeUserId = encodeURIComponent(userId);
    return parsed.pathname.includes(`/storage/v1/object/public/receipt-images/${safeUserId}/`) ||
      parsed.pathname.includes(`/storage/v1/object/sign/receipt-images/${safeUserId}/`);
  } catch {
    return false;
  }
}

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

// POST /api/ratings/receipt — attach a receipt image for internal validation
router.post('/receipt', requireAuth, async (req, res, next) => {
  try {
    const { rating_id, receipt_image_url, source = 'gallery' } = req.body;
    if (!rating_id || !receipt_image_url) {
      return res.status(400).json({ error: 'rating_id and receipt_image_url are required' });
    }
    if (!RECEIPT_SOURCES.has(source)) {
      return res.status(400).json({ error: 'source must be camera, gallery, or screenshot' });
    }
    if (!isOwnReceiptStorageUrl(receipt_image_url, req.userId)) {
      return res.status(400).json({ error: 'receipt image must be uploaded to your receipt storage folder' });
    }

    const { data: rating, error: ratingError } = await supabaseAdmin
      .from('ratings')
      .select('id, user_id, restaurant_id, dish_id, price, created_at')
      .eq('id', rating_id)
      .eq('user_id', req.userId)
      .maybeSingle();
    if (ratingError) throw ratingError;
    if (!rating) return res.status(404).json({ error: 'Rating not found' });

    const extractedData = {
      source,
      extraction_status: 'pending',
      submitted_at: new Date().toISOString(),
      rating_price: rating.price ?? null,
      restaurant_id: rating.restaurant_id,
      dish_id: rating.dish_id,
    };

    const { data, error } = await supabaseAdmin
      .from('rating_receipts')
      .insert({
        user_id: req.userId,
        rating_id,
        image_url: receipt_image_url,
        source,
        validation_status: 'pending',
        extracted_data: extractedData,
      })
      .select('id, validation_status')
      .single();
    if (error) throw error;

    res.status(201).json(data);
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

// POST /api/ratings/grouped — submit one feed post with multiple dish images.
// Body: {
//   restaurant_id, rating, comment?, tags?, receipt_image_url?, receipt_extracted_data?,
//   latitude?, longitude?,
//   items: [{ dish_name, image_url, price?, ai_confidence? }]
// }
router.post('/grouped', requireAuth, async (req, res, next) => {
  try {
    const {
      restaurant_id,
      rating: rawOverallRating,
      comment = '',
      tags = [],
      receipt_image_url = null,
      receipt_extracted_data = null,
      latitude = null,
      longitude = null,
      items = [],
    } = req.body;

    const overallRating = rawOverallRating != null ? parseRating(rawOverallRating) : null;
    if (overallRating === null && rawOverallRating != null) {
      return res.status(400).json({ error: 'overall rating must be between 1 and 5 if provided' });
    }
    if (!restaurant_id) {
      return res.status(400).json({ error: 'restaurant_id is required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items must include at least one dish' });
    }
    if (items.length > 10) {
      return res.status(400).json({ error: 'maximum 10 dishes per grouped post' });
    }

    const normalizedItems = items.map((item, index) => {
      const dishRating = parseRating(item?.rating);
      return {
        dish_name: String(item?.dish_name ?? item?.dishName ?? '').trim(),
        image_url: item?.image_url ?? item?.imageUrl ?? null,
        price: parseOptionalNumber(item?.price),
        ai_confidence: parseOptionalNumber(item?.ai_confidence ?? item?.aiConfidence),
        sort_order: Number.isInteger(item?.sort_order) ? item.sort_order : index,
        rating: dishRating,
      };
    });

    if (normalizedItems.some(item => !item.dish_name)) {
      return res.status(400).json({ error: 'each grouped item needs dish_name' });
    }
    if (normalizedItems.some(item => item.rating == null)) {
      return res.status(400).json({ error: 'each dish needs a rating between 1 and 5' });
    }

    const createdAt = new Date().toISOString();
    const groupId = uuidv4();

    const groupRating = overallRating ?? (normalizedItems.reduce((s, i) => s + i.rating, 0) / normalizedItems.length);

    const { data: group, error: groupError } = await supabaseAdmin
      .from('review_groups')
      .insert({
        id: groupId,
        user_id: req.userId,
        restaurant_id,
        rating: groupRating,
        comment: String(comment ?? '').slice(0, 2000),
        tags: cleanTags(tags),
        receipt_image_url,
        receipt_extracted_data: cleanReceiptPayload(receipt_extracted_data),
        latitude: parseOptionalNumber(latitude),
        longitude: parseOptionalNumber(longitude),
        created_at: createdAt,
      })
      .select()
      .single();
    if (groupError) throw groupError;

    const dishes = [];
    for (const item of normalizedItems) {
      dishes.push(await createOrGetDish({
        name: item.dish_name,
        restaurantId: restaurant_id,
        imageUrl: item.image_url,
      }));
    }

    const primaryRatingId = uuidv4();
    const ratingRows = normalizedItems.map((item, index) => ({
      id: index === 0 ? primaryRatingId : uuidv4(),
      user_id: req.userId,
      dish_id: dishes[index].id,
      restaurant_id,
      rating: item.rating,
      comment: index === 0 ? String(comment ?? '').slice(0, 2000) : '',
      image_url: item.image_url,
      latitude: parseOptionalNumber(latitude),
      longitude: parseOptionalNumber(longitude),
      price: item.price,
      group_id: groupId,
      created_at: createdAt,
    }));

    const { data: createdRatings, error: ratingError } = await supabaseAdmin
      .from('ratings')
      .insert(ratingRows)
      .select();
    if (ratingError) throw ratingError;

    const { error: updateGroupError } = await supabaseAdmin
      .from('review_groups')
      .update({ primary_rating_id: primaryRatingId })
      .eq('id', groupId);
    if (updateGroupError) throw updateGroupError;

    const groupItems = normalizedItems.map((item, index) => ({
      id: uuidv4(),
      group_id: groupId,
      rating_id: ratingRows[index].id,
      dish_id: dishes[index].id,
      dish_name: item.dish_name,
      image_url: item.image_url,
      price: item.price,
      sort_order: item.sort_order,
      ai_confidence: item.ai_confidence,
      created_at: createdAt,
    }));

    const { data: createdItems, error: itemsError } = await supabaseAdmin
      .from('review_group_items')
      .insert(groupItems)
      .select();
    if (itemsError) throw itemsError;

    dishes.forEach(dish => updateAverages(dish.id, restaurant_id).catch(console.error));

    res.status(201).json({
      group,
      rating: createdRatings?.[0] ?? null,
      items: createdItems ?? [],
      group_id: groupId,
      primary_rating_id: primaryRatingId,
    });
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
