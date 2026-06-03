/**
 * /api/social — user discovery, following feed, search
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

async function commentsCountByRatingId(ratingIds) {
  if (!ratingIds.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from('comments')
    .select('rating_id')
    .in('rating_id', ratingIds);
  if (error) throw error;

  return (data ?? []).reduce((counts, row) => {
    counts.set(row.rating_id, (counts.get(row.rating_id) ?? 0) + 1);
    return counts;
  }, new Map());
}

function normalizeRatingRow(row, commentCounts = new Map()) {
  const imageUrls = Array.isArray(row.image_urls)
    ? row.image_urls.filter(Boolean)
    : [];
  const dishImageUrl = row.image_url ?? row.dishes?.image_url ?? imageUrls[0] ?? null;

  return {
    id: row.id,
    user_id: row.user_id,
    user_name: row.profiles?.name || row.profiles?.username || 'Unknown',
    user_profile_url: row.profiles?.profile_photo_url ?? null,
    dish_id: row.dish_id,
    dish_name: row.dishes?.name || 'Unknown dish',
    dish_image_url: dishImageUrl,
    restaurant_name: row.restaurants?.name || 'Unknown restaurant',
    restaurant_city: row.restaurants?.city || '',
    rating: row.rating ?? 0,
    likes_count: row.likes_count ?? 0,
    comments_count: commentCounts.get(row.id) ?? 0,
    is_liked: false,
    comment: row.comment ?? '',
    image_urls: imageUrls.length ? imageUrls : (dishImageUrl ? [dishImageUrl] : []),
    price: row.price ?? null,
    currency_code: row.currency_code ?? null,
    created_at: row.created_at ?? null,
  };
}

async function normalizeRatingRows(rows) {
  const commentCounts = await commentsCountByRatingId((rows ?? []).map(row => row.id).filter(Boolean));
  return (rows ?? []).map(row => normalizeRatingRow(row, commentCounts));
}

// GET /api/social/discover — all users for discovery
router.get('/discover', requireAuth, async (req, res, next) => {
  try {
    const { data: users, error } = await supabaseAdmin
      .from('profiles')
      .select('id, name, username, profile_photo_url, bio, followers_count, following_count, level, total_points')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Get current user's following list
    const { data: following } = await supabaseAdmin
      .from('followers')
      .select('following_id')
      .eq('follower_id', req.userId);
    const followingSet = new Set((following ?? []).map(f => f.following_id));

    const annotated = users
      .filter(u => u.id !== req.userId)
      .map(u => ({ ...u, is_following: followingSet.has(u.id) }));
    res.json(annotated);
  } catch (err) { next(err); }
});

// GET /api/social/search?q=username&limit=6 — user search / suggestions
router.get('/search', requireAuth, async (req, res, next) => {
  try {
    const { q, limit = '6' } = req.query;
    if (!q) return res.status(400).json({ error: 'q required' });
    const normalized = q.replace(/^@/, '').toLowerCase();
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, name, username, profile_photo_url')
      .ilike('username', `${normalized}%`)
      .order('username', { ascending: true })
      .limit(parseInt(limit));
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/social/find-by-username?username=...
router.get('/find-by-username', requireAuth, async (req, res, next) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username required' });
    const normalized = username.replace(/^@/, '').toLowerCase();
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .ilike('username', normalized)
      .maybeSingle();
    if (error) throw error;
    res.json({ user_id: data?.id ?? null, id: data?.id ?? null });
  } catch (err) { next(err); }
});

// GET /api/social/feed/following?limit=20&offset=0
router.get('/feed/following', requireAuth, async (req, res, next) => {
  try {
    const { limit = '20', offset = '0' } = req.query;
    const { data: following } = await supabaseAdmin
      .from('followers')
      .select('following_id')
      .eq('follower_id', req.userId);
    const ids = (following ?? []).map(f => f.following_id);
    if (!ids.length) return res.json([]);

    const { data, error } = await supabaseAdmin
      .from('ratings')
      .select('*, profiles(id, name, username, profile_photo_url), dishes(id, name, image_url), restaurants(id, name, city)')
      .in('user_id', ids)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    if (error) throw error;
    res.json(await normalizeRatingRows(data));
  } catch (err) { next(err); }
});

// GET /api/social/feed-page — UI-ready paged feed from backend-owned RPC
router.get('/feed-page', requireAuth, async (req, res, next) => {
  try {
    const {
      filter = 'ALL',
      limit = '20',
      cursorCreatedAt,
      cursorId,
      cursorRating,
      userLat,
      userLon,
      userCity,
      radiusKm = '25.0',
    } = req.query;

    const { data, error } = await supabaseAdmin.rpc('get_feed_page', {
      p_filter: filter,
      p_limit: parseInt(limit, 10),
      p_cursor_created_at: cursorCreatedAt || null,
      p_cursor_id: cursorId || null,
      p_cursor_rating: cursorRating ? parseFloat(cursorRating) : null,
      p_user_lat: userLat ? parseFloat(userLat) : null,
      p_user_lon: userLon ? parseFloat(userLon) : null,
      p_user_city: userCity || null,
      p_radius_km: parseFloat(radiusKm),
      p_current_user_id: req.userId,
    });

    if (error) throw error;
    res.json(data ?? []);
  } catch (err) { next(err); }
});

// GET /api/social/profile/:userId — full profile with stats
router.get('/profile/:userId', requireAuth, async (req, res, next) => {
  try {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.params.userId)
      .maybeSingle();
    if (error) throw error;
    if (!profile) return res.status(404).json({ error: 'User not found' });

    // Follower / following counts from followers table (source of truth)
    const [{ data: followerRows }, { data: followingRows }] = await Promise.all([
      supabaseAdmin.from('followers').select('id').eq('following_id', req.params.userId),
      supabaseAdmin.from('followers').select('id').eq('follower_id', req.params.userId),
    ]);

    res.json({
      ...profile,
      followers_count: followerRows?.length ?? profile.followers_count,
      following_count: followingRows?.length ?? profile.following_count,
    });
  } catch (err) { next(err); }
});

// GET /api/social/ratings-by-ids?ids=a,b,c — bookmarked/saved rating cards
router.get('/ratings-by-ids', requireAuth, async (req, res, next) => {
  try {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean)
      .slice(0, 100);

    if (!ids.length) return res.json([]);

    const { data, error } = await supabaseAdmin
      .from('ratings')
      .select('*, profiles(id, name, username, profile_photo_url), dishes(id, name, image_url), restaurants(id, name, city)')
      .in('id', ids)
      .order('created_at', { ascending: false });
    if (error) throw error;

    res.json(await normalizeRatingRows(data));
  } catch (err) { next(err); }
});

// GET /api/social/ratings/:userId?limit=20&offset=0 — ratings by a user
router.get('/ratings/:userId', requireAuth, async (req, res, next) => {
  try {
    const { limit = '20', offset = '0' } = req.query;
    const { data, error } = await supabaseAdmin
      .from('ratings')
      .select('*, profiles(id, name, username, profile_photo_url), dishes(id, name, image_url), restaurants(id, name, city)')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
    if (error) throw error;
    res.json(await normalizeRatingRows(data));
  } catch (err) { next(err); }
});

export default router;
