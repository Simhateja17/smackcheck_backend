import test from 'node:test';
import assert from 'node:assert/strict';
import { extractGeminiText, parseGeminiJson } from '../src/lib/gemini.js';

test('extractGeminiText joins all candidate text parts', () => {
  const geminiResp = {
    candidates: [
      {
        content: {
          parts: [
            { text: 'Here is the JSON requested:\n```json\n' },
            { text: '{"dishName":"burger","confidence":0.94,"isFood":true,"itemType":"food","alternatives":[],"cuisine":"","restaurantChain":"","restaurantType":"","brand":"","genericName":"","evidence":""}\n```' },
          ],
        },
      },
    ],
  };

  assert.match(extractGeminiText(geminiResp), /"dishName":"burger"/);
});

test('parseGeminiJson handles prose wrapped around fenced JSON', () => {
  const rawText = [
    'Here is the JSON requested:',
    '```json',
    '{"dishName":"burger","confidence":0.94,"isFood":true,"itemType":"food","alternatives":[],"cuisine":"","restaurantChain":"","restaurantType":"","brand":"","genericName":"","evidence":""}',
    '```',
  ].join('\n');

  const parsed = parseGeminiJson(rawText, null);

  assert.equal(parsed.dishName, 'burger');
  assert.equal(parsed.isFood, true);
  assert.equal(parsed.itemType, 'food');
  assert.equal(parsed.confidence, 0.94);
});
