/**
 * /api/places — Google Places proxy (replaces the Supabase Edge Function calls)
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../config/supabase.js';
import crypto from 'crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const router = Router();
const PLACES_API_BASE = 'https://maps.googleapis.com/maps/api';

function apiKey() {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw Object.assign(new Error('GOOGLE_PLACES_API_KEY not configured'), { status: 503 });
  return key;
}

// GET /api/places/nearby?lat=...&lng=...&radius=5000&keyword=...&minRating=...
router.get('/nearby', requireAuth, async (req, res, next) => {
  try {
    const { lat, lng, radius = '5000', keyword, minRating } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    const url = new URL(`${PLACES_API_BASE}/place/nearbysearch/json`);
    url.searchParams.set('location', `${lat},${lng}`);
    url.searchParams.set('radius', radius);
    url.searchParams.set('type', 'restaurant');
    if (keyword) url.searchParams.set('keyword', keyword);
    url.searchParams.set('key', apiKey());

    const resp = await fetch(url.toString());
    const json = await resp.json();

    const HOTEL_TYPES = new Set(['lodging', 'hotel', 'motel', 'resort_hotel', 'hostel']);
    const FOOD_TYPES = new Set(['restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway', 'meal_delivery', 'food']);

    let results = (json.results ?? []).filter(p => {
      const types = p.types ?? [];
      if (types.some(t => HOTEL_TYPES.has(t))) return false;
      return types.some(t => FOOD_TYPES.has(t));
    });
    if (minRating) results = results.filter(r => (r.rating ?? 0) >= parseFloat(minRating));

    res.json(mapPlacesResults(results));
  } catch (err) { next(err); }
});

// GET /api/places/details?placeId=...
router.get('/details', requireAuth, async (req, res, next) => {
  try {
    const { placeId } = req.query;
    if (!placeId) return res.status(400).json({ error: 'placeId required' });

    const url = new URL(`${PLACES_API_BASE}/place/details/json`);
    url.searchParams.set('place_id', placeId);
    url.searchParams.set('fields', 'place_id,name,vicinity,geometry,rating,photos,types,price_level,formatted_address');
    url.searchParams.set('key', apiKey());

    const resp = await fetch(url.toString());
    const json = await resp.json();
    if (!json.result) return res.status(404).json({ error: 'Place not found' });
    res.json(mapPlaceResult(json.result));
  } catch (err) { next(err); }
});

// GET /api/places/search?query=...&lat=...&lng=...&radius=10000
router.get('/search', requireAuth, async (req, res, next) => {
  try {
    const { query, lat, lng, radius = '10000' } = req.query;
    if (!query) return res.status(400).json({ error: 'query required' });

    const url = new URL(`${PLACES_API_BASE}/place/textsearch/json`);
    url.searchParams.set('query', `${query} restaurant`);
    if (lat && lng) {
      url.searchParams.set('location', `${lat},${lng}`);
      url.searchParams.set('radius', radius);
    }
    url.searchParams.set('key', apiKey());

    const resp = await fetch(url.toString());
    const json = await resp.json();
    res.json(mapPlacesResults(json.results ?? []));
  } catch (err) { next(err); }
});

// GET /api/places/geocode?city=...
router.get('/geocode', requireAuth, async (req, res, next) => {
  try {
    const { city } = req.query;
    if (!city) return res.status(400).json({ error: 'city required' });

    const url = new URL(`${PLACES_API_BASE}/geocode/json`);
    url.searchParams.set('address', city);
    url.searchParams.set('key', apiKey());

    const resp = await fetch(url.toString());
    const json = await resp.json();
    const result = json.results?.[0];
    if (!result) return res.status(404).json({ error: 'City not found' });

    res.json({
      latitude: result.geometry.location.lat,
      longitude: result.geometry.location.lng,
      formatted_address: result.formatted_address,
    });
  } catch (err) { next(err); }
});

// GET /api/places/restaurant-photos?restaurantId=...&restaurantName=...&city=...&placeId=...
router.get('/restaurant-photos', requireAuth, async (req, res, next) => {
  try {
    const { restaurantId, restaurantName = '', city = '', placeId } = req.query;
    if (!restaurantId) return res.status(400).json({ error: 'restaurantId required' });

    const { data: cached } = await supabaseAdmin
      .from('restaurants')
      .select('photo_urls, image_url')
      .eq('id', restaurantId)
      .maybeSingle();

    const cachedUrls = (cached?.photo_urls?.length ? cached.photo_urls : (cached?.image_url ? [cached.image_url] : []))
      .filter(url => !isLegacyGooglePhotoUrl(url));
    if (cachedUrls.length) return res.json({ photos: cachedUrls });

    const photoRefs = await resolvePhotoReferences({ restaurantName, city, placeId });
    const photos = photoRefs
      .slice(0, 5)
      .map(ref => signedPhotoUrl(req, ref, 1200));

    if (photos.length) {
      await supabaseAdmin
        .from('restaurants')
        .update({ photo_urls: photos })
        .eq('id', restaurantId);
    }

    res.json({ photos });
  } catch (err) { next(err); }
});

// GET /api/places/photo?ref=...&maxWidth=800
// Public so image loaders can fetch it without custom Authorization headers.
router.get('/photo', async (req, res, next) => {
  try {
    const { ref, maxWidth = '800', exp, sig } = req.query;
    if (!ref) return res.status(400).json({ error: 'ref required' });
    if (!isValidPhotoSignature(ref, maxWidth, exp, sig)) {
      return res.status(403).json({ error: 'Invalid or expired photo URL' });
    }

    const url = new URL(`${PLACES_API_BASE}/place/photo`);
    url.searchParams.set('photoreference', ref);
    url.searchParams.set('maxwidth', maxWidth);
    url.searchParams.set('key', apiKey());

    const resp = await fetch(url.toString(), { redirect: 'follow' });
    if (!resp.ok || !resp.body) {
      const upstreamBody = await resp.text().catch(() => '');
      const err = new Error(`Google Places photo proxy failed: ${resp.status} ${upstreamBody}`.trim());
      err.status = resp.status >= 400 && resp.status < 500 ? resp.status : 502;
      throw err;
    }

    res.set('Content-Type', resp.headers.get('content-type') ?? 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    await pipeline(Readable.fromWeb(resp.body), res);
  } catch (err) { next(err); }
});

async function resolvePhotoReferences({ restaurantName, city, placeId }) {
  let resolvedPlaceId = placeId;
  if (!resolvedPlaceId && restaurantName) {
    const search = new URL(`${PLACES_API_BASE}/place/textsearch/json`);
    search.searchParams.set('query', `${restaurantName} ${city} restaurant`.trim());
    search.searchParams.set('key', apiKey());
    const searchResp = await fetch(search.toString());
    const searchJson = await searchResp.json();
    resolvedPlaceId = searchJson.results?.[0]?.place_id;
  }

  if (!resolvedPlaceId) return [];

  const details = new URL(`${PLACES_API_BASE}/place/details/json`);
  details.searchParams.set('place_id', resolvedPlaceId);
  details.searchParams.set('fields', 'photos');
  details.searchParams.set('key', apiKey());
  const detailsResp = await fetch(details.toString());
  const detailsJson = await detailsResp.json();
  return (detailsJson.result?.photos ?? []).map(ph => ph.photo_reference).filter(Boolean);
}

function absoluteUrl(req, path) {
  const configured = process.env.PUBLIC_BACKEND_URL || process.env.BACKEND_URL;
  if (configured) return `${configured.replace(/\/$/, '')}${path}`;
  return `${req.protocol}://${req.get('host')}${path}`;
}

function signedPhotoUrl(req, ref, maxWidth) {
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const sig = signPhotoParams(ref, String(maxWidth), String(exp));
  return absoluteUrl(
    req,
    `/api/places/photo?ref=${encodeURIComponent(ref)}&maxWidth=${maxWidth}&exp=${exp}&sig=${sig}`
  );
}

function isValidPhotoSignature(ref, maxWidth, exp, sig) {
  if (!exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = signPhotoParams(ref, String(maxWidth), String(exp));
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(String(sig));
  return expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function signPhotoParams(ref, maxWidth, exp) {
  const secret = process.env.PHOTO_PROXY_SIGNING_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.GOOGLE_PLACES_API_KEY;
  if (!secret) throw Object.assign(new Error('Photo proxy signing secret not configured'), { status: 503 });
  return crypto
    .createHmac('sha256', secret)
    .update(`${ref}:${maxWidth}:${exp}`)
    .digest('base64url');
}

function isLegacyGooglePhotoUrl(url) {
  return url.includes('googleusercontent.com') ||
    url.includes('maps.googleapis.com/maps/api/place/photo') ||
    url.includes('maps.gstatic.com') ||
    isExpiredSignedPhotoUrl(url);
}

function isExpiredSignedPhotoUrl(url) {
  try {
    if (!url.includes('/api/places/photo')) return false;
    const parsed = new URL(url);
    const exp = Number(parsed.searchParams.get('exp'));
    return !exp || exp < Math.floor(Date.now() / 1000);
  } catch {
    return true;
  }
}

function mapPlaceResult(p) {
  return {
    place_id: p.place_id,
    name: p.name,
    address: p.vicinity ?? p.formatted_address,
    latitude: p.geometry?.location?.lat,
    longitude: p.geometry?.location?.lng,
    rating: p.rating,
    photo_references: (p.photos ?? []).map(ph => ph.photo_reference),
    types: p.types ?? [],
  };
}

function mapPlacesResults(results) {
  return results.map(mapPlaceResult);
}

export default router;
