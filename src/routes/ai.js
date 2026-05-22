/**
 * /api/ai — AI dish detection via Gemini
 * Replaces the analyze-dish Supabase Edge Function.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/rateLimiter.js';

const router = Router();

const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1alpha';
const GEMINI_BASE = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}`;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const GEMINI_MEDIA_RESOLUTION = process.env.GEMINI_MEDIA_RESOLUTION || 'MEDIA_RESOLUTION_LOW';

function geminiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'your_gemini_api_key_here') {
    throw Object.assign(new Error('GEMINI_API_KEY not configured'), { status: 503 });
  }
  return key;
}

/**
 * POST /api/ai/detect-dish
 * Body (JSON): { imageBase64: string, mimeType?: string }
 * Returns: { dishName, confidence, cuisineType, description, isFood }
 */
router.post('/detect-dish', requireAuth, uploadLimiter, async (req, res, next) => {
  try {
    const startedAt = Date.now();
    const { imageBase64, mimeType = 'image/jpeg' } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
    const imageBytes = Math.ceil(String(imageBase64).length * 3 / 4);

    const prompt = 'Identify the dish. Return compact JSON only: {"isFood":boolean,"dishName":string|null,"cuisineType":string|null,"confidence":number,"description":string|null}';

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: { mime_type: mimeType, data: imageBase64 },
            media_resolution: { level: GEMINI_MEDIA_RESOLUTION },
          },
        ],
      }],
      generationConfig: {
        maxOutputTokens: 96,
        responseMimeType: 'application/json',
        thinkingConfig: {
          thinkingLevel: 'minimal',
        },
      },
    };

    const geminiStartedAt = Date.now();
    const resp = await fetch(
      `${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiKey(),
        },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      throw Object.assign(new Error(`Gemini API error: ${err}`), { status: 502 });
    }

    const geminiResp = await resp.json();
    const geminiMs = Date.now() - geminiStartedAt;
    const rawText = geminiResp.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

    // Strip markdown code fences if Gemini wraps the response
    const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      result = { isFood: false, dishName: null, cuisineType: null, confidence: 0, description: null };
    }

    console.info('[AI_DETECT_TIMING]', {
      model: GEMINI_MODEL,
      apiVersion: GEMINI_API_VERSION,
      mediaResolution: GEMINI_MEDIA_RESOLUTION,
      imageBytes,
      geminiMs,
      totalMs: Date.now() - startedAt,
      usage: geminiResp.usageMetadata,
    });

    res.json(result);
  } catch (err) { next(err); }
});

export default router;
