/**
 * /api/storage — image upload proxy to Supabase Storage
 */
import { Router } from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/rateLimiter.js';

const router = Router();

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(Object.assign(new Error('Unsupported file type'), { status: 400 }));
  },
});

const BUCKETS = {
  dish: 'dish-images',
  profile: 'profile-images',
  restaurant: 'restaurant-images',
  story: 'story-images',
};

/**
 * POST /api/storage/upload
 * Form fields: bucket (dish|profile|restaurant|story), file (multipart)
 * Returns: { url: string }
 */
router.post('/upload', requireAuth, uploadLimiter, upload.single('file'), async (req, res, next) => {
  try {
    const { bucket } = req.body;
    if (!bucket || !BUCKETS[bucket]) {
      return res.status(400).json({ error: `bucket must be one of: ${Object.keys(BUCKETS).join(', ')}` });
    }
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const ext = req.file.originalname.split('.').pop().toLowerCase() || 'jpg';
    const path = `${req.userId}/${Date.now()}.${ext}`;
    const bucketName = BUCKETS[bucket];

    const { error } = await supabaseAdmin.storage
      .from(bucketName)
      .upload(path, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });
    if (error) throw error;

    const { data: { publicUrl } } = supabaseAdmin.storage.from(bucketName).getPublicUrl(path);
    res.json({ url: publicUrl, path });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/storage/delete
 * Body: { bucket: string, path: string }
 */
router.delete('/delete', requireAuth, async (req, res, next) => {
  try {
    const { bucket, path } = req.body;
    if (!bucket || !BUCKETS[bucket] || !path) {
      return res.status(400).json({ error: 'bucket and path required' });
    }
    // Security: ensure path starts with the user's own folder
    if (!path.startsWith(`${req.userId}/`) && !path.startsWith(`${req.userId}.`)) {
      return res.status(403).json({ error: 'Cannot delete another user\'s file' });
    }
    const { error } = await supabaseAdmin.storage.from(BUCKETS[bucket]).remove([path]);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * GET /api/storage/url?bucket=dish&path=...
 */
router.get('/url', requireAuth, async (req, res, next) => {
  try {
    const { bucket, path } = req.query;
    if (!bucket || !BUCKETS[bucket] || !path) {
      return res.status(400).json({ error: 'bucket and path required' });
    }
    const { data: { publicUrl } } = supabaseAdmin.storage.from(BUCKETS[bucket]).getPublicUrl(path);
    res.json({ url: publicUrl });
  } catch (err) { next(err); }
});

export default router;
