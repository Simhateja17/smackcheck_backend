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

export function extractGeminiText(geminiResp) {
  const candidate = geminiResp?.candidates?.[0];
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();

  return text || '{}';
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
