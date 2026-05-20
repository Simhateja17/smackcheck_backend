import { sendPushToUser } from './firebase.js';

export async function isAdminUser(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('is_admin')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return data?.is_admin === true;
}

export async function createNotification(supabaseAdmin, {
  userId,
  eventType,
  title,
  body,
  data = {},
  push = true,
}) {
  if (!userId || !eventType || !title || !body) {
    throw Object.assign(new Error('userId, eventType, title, and body are required'), { status: 400 });
  }

  const { data: row, error } = await supabaseAdmin
    .from('notifications')
    .insert({
      user_id: userId,
      event_type: eventType,
      title,
      body,
      data,
      is_read: false,
    })
    .select()
    .single();

  if (error) throw error;

  if (push) {
    sendPushToUser(supabaseAdmin, userId, title, body, data).catch((err) => {
      console.error('[Notifications] push dispatch failed:', err);
    });
  }

  return row;
}

export async function profileDisplayName(supabaseAdmin, userId) {
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('name, username')
    .eq('id', userId)
    .maybeSingle();

  return data?.name || data?.username || 'Someone';
}

