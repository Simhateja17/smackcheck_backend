/**
 * /api/ai — AI dish detection via Gemini
 * Replaces the analyze-dish Supabase Edge Function.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { uploadLimiter } from '../middleware/rateLimiter.js';

const router = Router();

const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';
const GEMINI_BASE = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}`;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_MEDIA_RESOLUTION = process.env.GEMINI_MEDIA_RESOLUTION || 'MEDIA_RESOLUTION_HIGH';
const GEMINI_RECEIPT_MEDIA_RESOLUTION = process.env.GEMINI_RECEIPT_MEDIA_RESOLUTION || 'MEDIA_RESOLUTION_HIGH';

function geminiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'your_gemini_api_key_here') {
    throw Object.assign(new Error('GEMINI_API_KEY not configured'), { status: 503 });
  }
  return key;
}

function extractFirstJsonObject(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = inString;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  return null;
}

function parseJsonStringLiteral(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return String(value ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function recoverFlatJsonFields(text) {
  const source = String(text ?? '');
  const recovered = {};

  for (const match of source.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)"/g)) {
    recovered[match[1]] = parseJsonStringLiteral(match[2]);
  }

  for (const match of source.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*(true|false|null|-?\d+(?:\.\d+)?)/g)) {
    const [, key, rawValue] = match;
    if (rawValue === 'true') recovered[key] = true;
    else if (rawValue === 'false') recovered[key] = false;
    else if (rawValue === 'null') recovered[key] = null;
    else recovered[key] = Number(rawValue);
  }

  const alternativesMatch = source.match(/"alternatives"\s*:\s*(\[[^\]]*\])/);
  if (alternativesMatch) {
    try {
      const alternatives = JSON.parse(alternativesMatch[1]);
      if (Array.isArray(alternatives)) recovered.alternatives = alternatives;
    } catch {
      // Keep any other recovered fields; alternatives are optional.
    }
  }

  const hasDishName = typeof recovered.dishName === 'string' && recovered.dishName.trim();
  if (hasDishName && recovered.isFood !== false) {
    recovered.isFood = true;
    recovered.itemType = recovered.itemType || 'food';
  }

  return Object.keys(recovered).length > 0 ? recovered : null;
}

export function parseGeminiJson(rawText, fallback) {
  const cleaned = String(rawText ?? '{}')
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();
  const jsonObject = extractFirstJsonObject(cleaned) ?? cleaned;
  try {
    return JSON.parse(jsonObject);
  } catch (error) {
    const recovered = recoverFlatJsonFields(jsonObject);
    console.warn('[AI_DETECT_PARSE_ERROR]', {
      message: error.message,
      rawTextPreview: cleaned.slice(0, 500),
      extractedJsonPreview: jsonObject.slice(0, 500),
      recovered: Boolean(recovered),
      recoveredKeys: recovered ? Object.keys(recovered) : [],
    });
    return recovered ?? fallback;
  }
}

function summarizeGeminiResponse(geminiResp) {
  const candidate = geminiResp?.candidates?.[0];
  return {
    candidateCount: Array.isArray(geminiResp?.candidates) ? geminiResp.candidates.length : 0,
    finishReason: candidate?.finishReason,
    safetyRatings: candidate?.safetyRatings,
    promptFeedback: geminiResp?.promptFeedback,
    usage: geminiResp?.usageMetadata,
  };
}

function normalizeReceiptAnalysis(value) {
  const sourceSuggestions = value?.suggestions ?? value?.matches;
  const suggestions = Array.isArray(sourceSuggestions)
    ? sourceSuggestions
      .map((suggestion) => ({
        dishName: String(suggestion?.dishName ?? suggestion?.dish_name ?? '').trim(),
        price: Number.parseFloat(suggestion?.price),
        confidence: Number.parseFloat(suggestion?.confidence ?? 0),
      }))
      .filter((suggestion) => suggestion.dishName && Number.isFinite(suggestion.price))
    : [];

  const sourceRawItems = value?.rawItems ?? value?.raw_items ?? value?.receiptItems ?? value?.receipt_items ?? value?.lineItems ?? value?.line_items;
  const rawItems = Array.isArray(sourceRawItems)
    ? sourceRawItems.map((item) => {
      if (typeof item === 'string') return item;
      const name = item?.name ?? item?.item ?? item?.dishName ?? item?.dish_name ?? '';
      const price = item?.price ?? item?.amount ?? item?.total ?? '';
      return [name, price].filter((part) => String(part).trim()).join(' ');
    }).filter(Boolean).slice(0, 60)
    : [];

  return {
    summary: typeof value?.summary === 'string' ? value.summary.slice(0, 500) : null,
    rawItems,
    receiptItems: rawItems,
    suggestions,
    matches: suggestions,
  };
}

function normalizeReceiptToken(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !['dish', 'food', 'with', 'and', 'the', 'plate', 'item'].includes(token))
    .join(' ');
}

function parsePriceFromReceiptLine(line) {
  const matches = [...String(line).matchAll(/(?:[$₹]\s*)?(\d+(?:\.\d{1,2})?)/g)]
    .map((match) => Number.parseFloat(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (matches.length === 0) return null;
  return matches[matches.length - 1];
}

function inferReceiptSuggestionsFromRawItems(rawItems, dishNames) {
  const receiptLines = rawItems
    .map((line) => ({ line, normalized: normalizeReceiptToken(line), price: parsePriceFromReceiptLine(line) }))
    .filter((line) => line.normalized && line.price != null);
  if (receiptLines.length === 0) return [];

  const usedLineIndexes = new Set();
  const suggestions = [];

  for (const dishName of dishNames) {
    const normalizedDish = normalizeReceiptToken(dishName);
    if (!normalizedDish) continue;

    let best = null;
    receiptLines.forEach((line, index) => {
      if (usedLineIndexes.has(index)) return;
      const score = receiptMatchScore(normalizedDish, line.normalized);
      if (score > 0 && (!best || score > best.score)) {
        best = { index, line, score };
      }
    });

    if (best && best.score >= 20) {
      usedLineIndexes.add(best.index);
      suggestions.push({
        dishName,
        price: best.line.price,
        confidence: Math.min(1, best.score / 100),
      });
    }
  }

  if (suggestions.length === 0) {
    rawItems.slice(0, dishNames.length).forEach((line, index) => {
      const price = parsePriceFromReceiptLine(line);
      if (price != null && dishNames[index]) {
        suggestions.push({ dishName: dishNames[index], price, confidence: 0.35 });
      }
    });
  }

  return suggestions;
}

function receiptMatchScore(dishName, receiptLine) {
  if (dishName === receiptLine) return 100;
  if (dishName.includes(receiptLine) || receiptLine.includes(dishName)) return 80;

  const dishTokens = new Set(dishName.split(' ').filter((token) => token.length >= 3));
  const lineTokens = new Set(receiptLine.split(' ').filter((token) => token.length >= 3));
  const overlap = [...dishTokens].filter((token) => lineTokens.has(token)).length;
  return overlap * 25;
}

export function normalizeDishDetection(value) {
  const isFood = value?.isFood !== false;
  const dishName = String(value?.dishName ?? value?.dish_name ?? '').trim();
  const cuisine = String(value?.cuisine ?? value?.cuisineType ?? value?.cuisine_type ?? '').trim();
  const itemType = String(value?.itemType ?? value?.item_type ?? (isFood ? 'food' : 'unknown')).trim().toLowerCase();
  const confidence = Number.parseFloat(value?.confidence ?? 0);
  const alternatives = Array.isArray(value?.alternatives)
    ? value.alternatives.map((item) => String(item)).filter(Boolean).slice(0, 5)
    : [];

  return {
    isFood,
    dishName: dishName || 'Unknown',
    cuisine,
    cuisineType: cuisine,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    alternatives,
    description: typeof value?.description === 'string' ? value.description.slice(0, 500) : '',
    ingredients: Array.isArray(value?.ingredients)
      ? value.ingredients.map((item) => String(item)).filter(Boolean).slice(0, 20)
      : [],
    itemType: ['food', 'beverage'].includes(itemType) ? itemType : (isFood ? 'food' : 'unknown'),
    restaurantChain: String(value?.restaurantChain ?? value?.restaurant_chain ?? '').trim(),
    restaurantType: String(value?.restaurantType ?? value?.restaurant_type ?? '').trim(),
    error: null,
  };
}

/**
 * POST /api/ai/detect-dish
 * Body (JSON): { imageBase64: string, mimeType?: string }
 * Returns the same shape as the old analyze-dish Edge Function.
 */
router.post('/detect-dish', requireAuth, uploadLimiter, async (req, res, next) => {
  try {
    const startedAt = Date.now();
    const { imageBase64, mimeType = 'image/jpeg' } = req.body;
    if (!imageBase64) {
      console.warn('[AI_DETECT_BAD_REQUEST]', {
        requestId: req.requestId,
        userId: req.userId,
        reason: 'imageBase64 required',
        bodyKeys: Object.keys(req.body ?? {}),
      });
      return res.status(400).json({ error: 'imageBase64 required' });
    }
    const imageBytes = Math.ceil(String(imageBase64).length * 3 / 4);

    console.info('[AI_DETECT_START]', {
      requestId: req.requestId,
      userId: req.userId,
      model: GEMINI_MODEL,
      apiVersion: GEMINI_API_VERSION,
      mediaResolution: GEMINI_MEDIA_RESOLUTION,
      mimeType,
      base64Chars: String(imageBase64).length,
      estimatedImageBytes: imageBytes,
      jsonBodyLimit: process.env.JSON_BODY_LIMIT ?? '8mb',
    });

    const prompt = [
      'Identify the food or beverage in this image.',
      'Return compact JSON only with this shape:',
      '{"isFood":boolean,"dishName":string,"cuisine":string,"confidence":number,"alternatives":string[],"itemType":"food|beverage|unknown","restaurantChain":string,"restaurantType":string}',
      'Use the most specific common dish name. For example, say "pesto pasta" instead of just "pasta" when visible.',
      'If multiple dishes are visible, name the most prominent foreground dish.',
      'Do not return Unknown if a recognizable food or drink is visible.',
      'Do not include description, ingredients, markdown, or prose.',
    ].join('\n');

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
        maxOutputTokens: 256,
        responseMimeType: 'application/json',
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
    const geminiMs = Date.now() - geminiStartedAt;

    console.info('[AI_DETECT_GEMINI_HTTP]', {
      requestId: req.requestId,
      userId: req.userId,
      status: resp.status,
      ok: resp.ok,
      statusText: resp.statusText,
      geminiMs,
      model: GEMINI_MODEL,
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('[AI_DETECT_GEMINI_ERROR]', {
        requestId: req.requestId,
        userId: req.userId,
        status: resp.status,
        statusText: resp.statusText,
        geminiMs,
        errorPreview: err.slice(0, 1000),
      });
      throw Object.assign(new Error(`Gemini API error: ${err}`), { status: 502 });
    }

    const geminiResp = await resp.json();
    const rawText = geminiResp.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

    console.info('[AI_DETECT_GEMINI_RESPONSE]', {
      requestId: req.requestId,
      userId: req.userId,
      ...summarizeGeminiResponse(geminiResp),
      rawTextPreview: rawText.slice(0, 500),
    });

    // Strip markdown code fences if Gemini wraps the response
    const result = normalizeDishDetection(parseGeminiJson(rawText, {
      isFood: true,
      dishName: null,
      cuisine: null,
      confidence: 0,
      description: null,
      itemType: 'food',
    }));

    console.info('[AI_DETECT_RESULT]', {
      requestId: req.requestId,
      userId: req.userId,
      model: GEMINI_MODEL,
      apiVersion: GEMINI_API_VERSION,
      mediaResolution: GEMINI_MEDIA_RESOLUTION,
      imageBytes,
      geminiMs,
      totalMs: Date.now() - startedAt,
      dishName: result.dishName,
      cuisine: result.cuisine,
      confidence: result.confidence,
      itemType: result.itemType,
      isFood: result.isFood,
      alternatives: result.alternatives,
      restaurantChain: result.restaurantChain,
      restaurantType: result.restaurantType,
    });

    res.json(result);
  } catch (err) {
    console.error('[AI_DETECT_FAILURE]', {
      requestId: req.requestId,
      userId: req.userId,
      message: err.message,
      status: err.status,
      stack: err.stack,
    });
    next(err);
  }
});

/**
 * POST /api/ai/analyze-receipt
 * Body (JSON): { imageBase64: string, mimeType?: string, dishNames?: string[] }
 * Returns: { summary, rawItems, receiptItems, suggestions, matches }
 */
router.post('/analyze-receipt', requireAuth, uploadLimiter, async (req, res, next) => {
  try {
    const startedAt = Date.now();
    const { imageBase64, mimeType = 'image/jpeg', dishNames = [] } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    const names = Array.isArray(dishNames)
      ? dishNames.map((name) => String(name).trim()).filter(Boolean).slice(0, 20)
      : [];
    const imageBytes = Math.ceil(String(imageBase64).length * 3 / 4);
    const prompt = [
      'You are reading a restaurant, cafe, theater, or food delivery receipt image.',
      'First OCR every visible purchased food or drink line item with its price, then match line-item prices to the uploaded dish names.',
      'Return compact JSON only with this shape:',
      '{"summary":string|null,"rawItems":string[],"suggestions":[{"dishName":string,"price":number,"confidence":number}]}',
      'Use the exact dishName from this list when possible:',
      JSON.stringify(names),
      'rawItems must include visible purchasable line items such as "AVOCADO BURGER 14.99", "SM POPCORN 8.50", or "PESTO PASTA 12.00".',
      'Ignore subtotal, tax, tip, service charge, discounts, balance, change, payment, card, approval, and total lines.',
      'If there is no exact name match, match the closest food category: any burger line can match an uploaded burger dish, pasta can match pasta, biryani can match rice/biryani, fries can match fries.',
      'If only one uploaded dish name is provided and exactly one plausible food line item price is visible, return that price for the dish with confidence 0.45 even if the names differ.',
      'Only include numeric item prices. Do not invent prices if no item price is visible.',
    ].join('\n');

    const body = {
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: { mime_type: mimeType, data: imageBase64 },
            media_resolution: { level: GEMINI_RECEIPT_MEDIA_RESOLUTION },
          },
        ],
      }],
      generationConfig: {
        maxOutputTokens: 512,
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
    const rawText = geminiResp.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsedReceipt = normalizeReceiptAnalysis(parseGeminiJson(rawText, {}));
    const inferredSuggestions = parsedReceipt.suggestions.length === 0
      ? inferReceiptSuggestionsFromRawItems(parsedReceipt.rawItems, names)
      : [];
    const result = inferredSuggestions.length > 0
      ? {
        ...parsedReceipt,
        suggestions: inferredSuggestions,
        matches: inferredSuggestions,
      }
      : parsedReceipt;

    console.info('[AI_RECEIPT_TIMING]', {
      model: GEMINI_MODEL,
      apiVersion: GEMINI_API_VERSION,
      mediaResolution: GEMINI_RECEIPT_MEDIA_RESOLUTION,
      imageBytes,
      dishCount: names.length,
      geminiMs: Date.now() - geminiStartedAt,
      totalMs: Date.now() - startedAt,
      usage: geminiResp.usageMetadata,
    });

    res.json(result);
  } catch (err) { next(err); }
});

export default router;
