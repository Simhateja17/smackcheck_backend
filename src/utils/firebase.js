/**
 * Firebase Cloud Messaging helper — server-side push notifications.
 * Replaces the push notification Supabase Edge Function.
 *
 * Uses the FCM v1 HTTP API (OAuth2 Bearer, not legacy server key).
 * Requires FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_PATH in .env.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

let _accessToken = null;
let _tokenExpiry = 0;
let _serviceAccount = null;

function getServiceAccount() {
  if (_serviceAccount) return _serviceAccount;
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!filePath) throw new Error('FIREBASE_SERVICE_ACCOUNT_PATH not set in .env');
  const absPath = resolve(__dirname, '../../', filePath);
  _serviceAccount = JSON.parse(readFileSync(absPath, 'utf8'));
  return _serviceAccount;
}

/**
 * Get a short-lived OAuth2 access token for FCM using the service account.
 * Tokens are cached for their lifetime.
 */
async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry - 30_000) return _accessToken;

  const sa = getServiceAccount();

  // Build a JWT assertion
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: FCM_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));

  // Sign using the private key via SubtleCrypto (available in Node 18+)
  const pemKey = sa.private_key;
  const keyData = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');

  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const b64sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const jwt = `${signingInput}.${b64sig}`;

  // Exchange JWT for access token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Firebase token exchange failed: ${err}`);
  }

  const { access_token, expires_in } = await resp.json();
  _accessToken = access_token;
  _tokenExpiry = Date.now() + expires_in * 1000;
  return _accessToken;
}

/**
 * Send a push notification to a single FCM token.
 *
 * @param {string} pushToken   — device FCM token
 * @param {string} title
 * @param {string} body
 * @param {object} data        — arbitrary key-value string pairs
 * @returns {Promise<boolean>} — true on success
 */
export async function sendPushNotification(pushToken, title, body, data = {}) {
  if (!pushToken) return false;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    console.warn('[Firebase] FIREBASE_PROJECT_ID not set — skipping push notification');
    return false;
  }

  try {
    const token = await getAccessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    const message = {
      message: {
        token: pushToken,
        notification: { title, body },
        data: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
        android: {
          priority: 'high',
          notification: { sound: 'default' },
        },
        apns: {
          payload: { aps: { sound: 'default', badge: 1 } },
        },
      },
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!resp.ok) {
      const err = await resp.json();
      // Invalid token — clear it from the profile
      if (err?.error?.details?.some(d => d.errorCode === 'UNREGISTERED')) {
        return false; // caller should clear push_token in DB
      }
      throw new Error(JSON.stringify(err));
    }

    return true;
  } catch (err) {
    console.error('[Firebase] sendPushNotification error:', err.message);
    return false;
  }
}

/**
 * Convenience: send a push to a user by looking up their push_token from profiles.
 * Automatically clears the token if it's unregistered.
 */
export async function sendPushToUser(supabaseAdmin, userId, title, body, data = {}) {
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('push_token')
    .eq('id', userId)
    .maybeSingle();

  if (!profile?.push_token) return false;

  const sent = await sendPushNotification(profile.push_token, title, body, data);

  // Clear stale token
  if (!sent) {
    await supabaseAdmin
      .from('profiles')
      .update({ push_token: null })
      .eq('id', userId);
  }

  return sent;
}
