/**
 * Minimal Azure OpenAI client for vision + JSON chat completions.
 * Uses the Azure OpenAI v1 API: {endpoint}/openai/v1/chat/completions
 */

export const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4.1-mini';
export const AZURE_OPENAI_IMAGE_DETAIL = process.env.AZURE_OPENAI_IMAGE_DETAIL || 'high';

function azureConfig() {
  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !apiKey || apiKey === 'your_azure_openai_api_key_here') {
    throw Object.assign(new Error('AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY not configured'), { status: 503 });
  }
  return { endpoint, apiKey };
}

/**
 * Send a prompt + base64 image and return { rawText, usage, finishReason, status, ms }.
 * responseFormat: an OpenAI response_format object (json_object or json_schema).
 */
export async function azureVisionJson({ prompt, imageBase64, mimeType, maxTokens, responseFormat }) {
  const { endpoint, apiKey } = azureConfig();
  const startedAt = Date.now();

  const resp = await fetch(`${endpoint}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      model: AZURE_OPENAI_DEPLOYMENT,
      temperature: 0.1,
      max_completion_tokens: maxTokens,
      response_format: responseFormat ?? { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: AZURE_OPENAI_IMAGE_DETAIL },
          },
        ],
      }],
    }),
  });
  const ms = Date.now() - startedAt;

  if (!resp.ok) {
    const err = await resp.text();
    throw Object.assign(new Error(`Azure OpenAI API error (${resp.status}): ${err}`), { status: 502, azureMs: ms });
  }

  const data = await resp.json();
  const choice = data?.choices?.[0];
  return {
    rawText: (typeof choice?.message?.content === 'string' && choice.message.content.trim()) || '{}',
    finishReason: choice?.finish_reason,
    usage: data?.usage,
    status: resp.status,
    ms,
  };
}
