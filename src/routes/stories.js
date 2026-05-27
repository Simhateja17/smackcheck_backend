/**
 * /api/stories
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

function storyNeedsContext(story) {
  return !story?.dish_name || story?.rating == null || !story?.city;
}

function toStoryResponse(story) {
  const profile = story.profiles ?? {};
  return {
    id: story.id,
    user_id: story.user_id,
    image_url: story.image_url,
    dish_name: story.dish_name ?? null,
    rating: story.rating ?? null,
    city: story.city ?? null,
    created_at: story.created_at,
    expires_at: story.expires_at,
    user_name: profile.name ?? profile.username ?? null,
    user_profile_url: profile.profile_photo_url ?? null,
  };
}

async function fetchStoryContextByImage(visibleUserIds, storyImageUrls) {
  if (!visibleUserIds.length || !storyImageUrls.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from('ratings')
    .select('user_id, image_url, rating, dishes(name), restaurants(city), created_at')
    .in('user_id', visibleUserIds)
    .in('image_url', storyImageUrls)
    .not('image_url', 'is', null)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const contextByKey = new Map();
  for (const row of data ?? []) {
    const key = `${row.user_id}:${row.image_url}`;
    if (!contextByKey.has(key)) {
      contextByKey.set(key, {
        dish_name: row.dishes?.name ?? null,
        rating: row.rating ?? null,
        city: row.restaurants?.city ?? null,
      });
    }
  }
  return contextByKey;
}

async function fetchLatestContextByUser(visibleUserIds) {
  if (!visibleUserIds.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from('ratings')
    .select('user_id, rating, dishes(name), restaurants(city), image_url, created_at')
    .in('user_id', visibleUserIds)
    .not('image_url', 'is', null)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const latestByUser = new Map();
  for (const row of data ?? []) {
    if (!latestByUser.has(row.user_id)) {
      latestByUser.set(row.user_id, {
        dish_name: row.dishes?.name ?? null,
        rating: row.rating ?? null,
        city: row.restaurants?.city ?? null,
      });
    }
  }
  return latestByUser;
}

function withContextFallback(story, contextByImageKey, latestByUser) {
  if (!storyNeedsContext(story)) return story;

  const byImage = story.image_url ? contextByImageKey.get(`${story.user_id}:${story.image_url}`) : null;
  const byUser = latestByUser.get(story.user_id) ?? null;
  const fallback = byImage ?? byUser;
  if (!fallback) return story;

  return {
    ...story,
    dish_name: story.dish_name ?? fallback.dish_name ?? null,
    rating: story.rating ?? fallback.rating ?? null,
    city: story.city ?? fallback.city ?? null,
  };
}

async function inferContextForCreate(userId, imageUrl) {
  const { data, error } = await supabaseAdmin
    .from('ratings')
    .select('rating, image_url, dishes(name), restaurants(city), created_at')
    .eq('user_id', userId)
    .not('image_url', 'is', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const rows = data ?? [];
  if (!rows.length) return {};

  const imageMatch = rows.find(row => row.image_url === imageUrl);
  const best = imageMatch ?? rows[0];
  return {
    dish_name: best.dishes?.name ?? null,
    rating: best.rating ?? null,
    city: best.restaurants?.city ?? null,
  };
}

// GET /api/stories — active stories from the current user and followed users
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { data: following, error: followingError } = await supabaseAdmin
      .from('followers')
      .select('following_id')
      .eq('follower_id', req.userId);
    if (followingError) throw followingError;

    const visibleUserIds = [req.userId, ...new Set((following ?? []).map(f => f.following_id))];

    const { data, error } = await supabaseAdmin
      .from('stories')
      .select('*, profiles(id, name, username, profile_photo_url)')
      .in('user_id', visibleUserIds)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error) throw error;

    const stories = data ?? [];
    const imageUrls = [...new Set(stories.map(story => story.image_url).filter(Boolean))];
    const [contextByImageKey, latestByUser] = await Promise.all([
      fetchStoryContextByImage(visibleUserIds, imageUrls),
      fetchLatestContextByUser(visibleUserIds),
    ]);

    const hydratedStories = stories.map(story => withContextFallback(story, contextByImageKey, latestByUser));
    res.json(hydratedStories.map(toStoryResponse));
  } catch (err) { next(err); }
});

// GET /api/stories/by-user?userId=...
router.get('/by-user', requireAuth, async (req, res, next) => {
  try {
    const userId = req.query.userId ?? req.userId;
    const { data, error } = await supabaseAdmin
      .from('stories')
      .select('*')
      .eq('user_id', userId)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/stories — upload a story
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { image_url, dish_name, rating, city } = req.body;
    if (!image_url) return res.status(400).json({ error: 'image_url required' });
    const parsedRating = rating == null ? null : parseFloat(rating);
    if (parsedRating != null && (Number.isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5)) {
      return res.status(400).json({ error: 'rating must be between 1 and 5' });
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const inputContext = {
      dish_name: dish_name?.toString().slice(0, 120) ?? null,
      rating: parsedRating,
      city: city?.toString().slice(0, 80) ?? null,
    };
    const fallbackContext = storyNeedsContext(inputContext)
      ? await inferContextForCreate(req.userId, image_url)
      : {};

    const { data, error } = await supabaseAdmin
      .from('stories')
      .insert({
        user_id: req.userId,
        image_url,
        dish_name: inputContext.dish_name ?? fallbackContext.dish_name ?? null,
        rating: inputContext.rating ?? fallbackContext.rating ?? null,
        city: inputContext.city ?? fallbackContext.city ?? null,
        expires_at: expiresAt,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// DELETE /api/stories/:id
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('stories')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.userId);
    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
