/**
 * /api/admin - shared backend for the admin panel.
 *
 * Admin actions are intentionally safe transitions: update status fields,
 * write an audit row, and notify users when appropriate. Nothing here hard
 * deletes user or content records.
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAdmin } from '../middleware/auth.js';
import { createNotification } from '../utils/notifications.js';

const router = Router();

router.use(requireAdmin);

const PAGE_LIMIT_MAX = 100;
const CONTENT_TABLES = {
  rating: 'ratings',
  comment: 'comments',
  story: 'stories',
};
const CONTENT_STATUSES = new Set(['pending', 'approved', 'hidden', 'rejected']);
const RESTAURANT_STATUSES = new Set(['pending', 'verified', 'hidden', 'duplicate']);
const DISH_STATUSES = new Set(['pending', 'approved', 'hidden', 'rejected']);
const REPORT_STATUSES = new Set(['open', 'reviewing', 'resolved', 'dismissed']);
const USER_ACTIONS = new Set(['warn', 'suspend', 'ban', 'restore']);
const CONTENT_ACTION_TO_STATUS = {
  approve: 'approved',
  restore: 'approved',
  hide: 'hidden',
  reject: 'rejected',
  remove: 'rejected',
};

const USER_ACTION_COPY = {
  warn: {
    title: 'Account warning',
    body: 'Your account received a warning from SmackCheck moderation. Please review our community guidelines before posting again.',
  },
  suspend: {
    title: 'Account temporarily restricted',
    body: 'Your account has been temporarily restricted by SmackCheck moderation. You can still view your account, but some actions may be limited.',
  },
  ban: {
    title: 'Account banned',
    body: 'Your account has been banned by SmackCheck moderation because of a serious or repeated policy violation.',
  },
  restore: {
    title: 'Account restored',
    body: 'Your SmackCheck account has been restored. You can use the app again.',
  },
};

function parsePage(query) {
  const limit = Math.min(Math.max(parseInt(query.limit ?? '25', 10) || 25, 1), PAGE_LIMIT_MAX);
  const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);
  return { limit, offset, end: offset + limit - 1 };
}

function cleanSearch(value) {
  return String(value ?? '').trim().replace(/[%,]/g, '');
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

async function logModerationAction({ moderatorId, targetType, targetId, action, reason }) {
  const { data, error } = await supabaseAdmin
    .from('moderation_actions')
    .insert({
      moderator_id: moderatorId,
      target_type: targetType,
      target_id: targetId,
      action,
      reason: reason ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function notifyUserSafely(userId, { title, body, data }) {
  if (!userId) return;
  try {
    await createNotification(supabaseAdmin, {
      userId,
      eventType: 'admin_action',
      title,
      body,
      data,
      push: true,
    });
  } catch (error) {
    console.error('[Admin] notification failed', { userId, message: error.message });
  }
}

async function getRatingOwner(ratingId) {
  const { data, error } = await supabaseAdmin
    .from('ratings')
    .select('user_id')
    .eq('id', ratingId)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

async function getCommentOwner(commentId) {
  const { data, error } = await supabaseAdmin
    .from('comments')
    .select('user_id')
    .eq('id', commentId)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

async function getStoryOwner(storyId) {
  const { data, error } = await supabaseAdmin
    .from('stories')
    .select('user_id')
    .eq('id', storyId)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ?? null;
}

async function getTargetOwner(targetType, targetId) {
  if (targetType === 'rating') return getRatingOwner(targetId);
  if (targetType === 'comment') return getCommentOwner(targetId);
  if (targetType === 'story') return getStoryOwner(targetId);
  if (targetType === 'profile' || targetType === 'user') return targetId;
  return null;
}

async function applyContentStatus(targetType, targetId, status) {
  const table = CONTENT_TABLES[targetType];
  if (!table) throw badRequest('target_type must be rating, comment, or story');
  if (!CONTENT_STATUSES.has(status)) throw badRequest('Invalid content status');

  const { data, error } = await supabaseAdmin
    .from(table)
    .update({ content_status: status })
    .eq('id', targetId)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Target content not found'), { status: 404 });
  return data;
}

async function applyUserAction(userId, action) {
  const statusByAction = {
    suspend: 'restricted',
    ban: 'banned',
    restore: 'active',
  };
  const nextStatus = statusByAction[action];
  if (!nextStatus) {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, account_status')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('User not found'), { status: 404 });
    return data;
  }

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ account_status: nextStatus })
    .eq('id', userId)
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('User not found'), { status: 404 });
  return data;
}

async function countTable(table, configure = q => q) {
  const { count, error } = await configure(
    supabaseAdmin.from(table).select('*', { count: 'exact', head: true }),
  );
  if (error) throw error;
  return count ?? 0;
}

router.get('/me', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, name, username, email, profile_photo_url, is_admin, account_status')
      .eq('id', req.userId)
      .maybeSingle();
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

router.get('/dashboard', async (_req, res, next) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      totalUsers,
      activeUsers24h,
      newUsers7d,
      totalRatings,
      ratings24h,
      totalRestaurants,
      pendingReports,
      moderationQueue,
      hiddenContent,
      recentUsers,
      recentReports,
      recentActions,
      topDishes,
    ] = await Promise.all([
      countTable('profiles'),
      countTable('profiles', q => q.gte('last_rating_date', since24h)),
      countTable('profiles', q => q.gte('created_at', since7d)),
      countTable('ratings'),
      countTable('ratings', q => q.gte('created_at', since24h)),
      countTable('restaurants'),
      countTable('reports', q => q.eq('status', 'open')),
      countTable('reports', q => q.in('status', ['open', 'reviewing'])),
      countTable('ratings', q => q.in('content_status', ['hidden', 'rejected'])),
      supabaseAdmin.from('profiles')
        .select('id, name, username, email, created_at, account_status, profile_photo_url')
        .order('created_at', { ascending: false })
        .limit(5),
      supabaseAdmin.from('reports')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5),
      supabaseAdmin.from('moderation_actions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(8),
      supabaseAdmin.from('dishes')
        .select('id, name, restaurant_id, image_url, average_rating, review_count, restaurants(name, city)')
        .order('review_count', { ascending: false })
        .limit(5),
    ]);

    for (const result of [recentUsers, recentReports, recentActions, topDishes]) {
      if (result.error) throw result.error;
    }

    res.json({
      stats: {
        totalUsers,
        activeUsers24h,
        newUsers7d,
        totalRatings,
        ratings24h,
        totalRestaurants,
        pendingReports,
        moderationQueue,
        hiddenContent,
      },
      recentUsers: recentUsers.data ?? [],
      recentReports: recentReports.data ?? [],
      recentActions: recentActions.data ?? [],
      topDishes: topDishes.data ?? [],
    });
  } catch (err) { next(err); }
});

router.get('/users', async (req, res, next) => {
  try {
    const { limit, offset, end } = parsePage(req.query);
    const { status = 'all', role = 'all' } = req.query;
    const search = cleanSearch(req.query.q);

    let query = supabaseAdmin
      .from('profiles')
      .select('id, name, username, email, profile_photo_url, bio, last_location, level, xp, followers_count, following_count, last_rating_date, account_status, is_admin, created_at, updated_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, end);

    if (status !== 'all') query = query.eq('account_status', status);
    if (role === 'admin') query = query.eq('is_admin', true);
    if (role === 'user') query = query.or('is_admin.is.null,is_admin.eq.false');
    if (search) query = query.or(`name.ilike.%${search}%,username.ilike.%${search}%,email.ilike.%${search}%`);

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ users: data ?? [], count: count ?? 0, limit, offset });
  } catch (err) { next(err); }
});

router.get('/users/:id', async (req, res, next) => {
  try {
    const [profile, ratings, reports, badges, actions] = await Promise.all([
      supabaseAdmin.from('profiles').select('*').eq('id', req.params.id).maybeSingle(),
      supabaseAdmin.from('ratings')
        .select('*, dishes(id, name, image_url), restaurants(id, name, city)')
        .eq('user_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(20),
      supabaseAdmin.from('reports')
        .select('*')
        .or(`reporter_id.eq.${req.params.id},target_id.eq.${req.params.id}`)
        .order('created_at', { ascending: false })
        .limit(20),
      supabaseAdmin.from('user_badges')
        .select('*, badges(*)')
        .eq('user_id', req.params.id)
        .order('earned_at', { ascending: false })
        .limit(20),
      supabaseAdmin.from('moderation_actions')
        .select('*')
        .in('target_type', ['profile', 'user'])
        .eq('target_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    if (profile.error) throw profile.error;
    if (!profile.data) return res.status(404).json({ error: 'User not found' });
    for (const result of [ratings, reports, badges, actions]) {
      if (result.error) throw result.error;
    }

    res.json({
      user: profile.data,
      ratings: ratings.data ?? [],
      reports: reports.data ?? [],
      badges: badges.data ?? [],
      actions: actions.data ?? [],
    });
  } catch (err) { next(err); }
});

router.post('/users/:id/action', async (req, res, next) => {
  try {
    const { action, reason } = req.body;
    if (!USER_ACTIONS.has(action)) throw badRequest('action must be warn, suspend, ban, or restore');
    if (req.params.id === req.userId && action === 'ban') throw badRequest('Admins cannot ban themselves');

    const user = await applyUserAction(req.params.id, action);
    const log = await logModerationAction({
      moderatorId: req.userId,
      targetType: 'user',
      targetId: req.params.id,
      action,
      reason,
    });

    const copy = USER_ACTION_COPY[action];
    await notifyUserSafely(req.params.id, {
      title: copy.title,
      body: reason ? `${copy.body} Reason: ${reason}` : copy.body,
      data: {
        screen: 'Notifications',
        action,
        reason: reason ?? null,
        account_status: user?.account_status ?? null,
        moderated_by: req.userId,
      },
    });

    res.json({ success: true, user, action: log });
  } catch (err) { next(err); }
});

router.get('/reports', async (req, res, next) => {
  try {
    const { limit, offset, end } = parsePage(req.query);
    const { status = 'all', targetType = 'all' } = req.query;

    let query = supabaseAdmin
      .from('reports')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, end);
    if (status !== 'all') query = query.eq('status', status);
    if (targetType !== 'all') query = query.eq('target_type', targetType);

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ reports: data ?? [], count: count ?? 0, limit, offset });
  } catch (err) { next(err); }
});

router.get('/reports/:id', async (req, res, next) => {
  try {
    const { data: report, error } = await supabaseAdmin
      .from('reports')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const [reporter, targetOwner, actions] = await Promise.all([
      supabaseAdmin.from('profiles')
        .select('id, name, username, email, profile_photo_url, account_status')
        .eq('id', report.reporter_id)
        .maybeSingle(),
      getTargetOwner(report.target_type, report.target_id),
      supabaseAdmin.from('moderation_actions')
        .select('*')
        .eq('target_type', report.target_type)
        .eq('target_id', report.target_id)
        .order('created_at', { ascending: false }),
    ]);

    if (reporter.error) throw reporter.error;
    if (actions.error) throw actions.error;

    res.json({
      report,
      reporter: reporter.data ?? null,
      targetOwnerId: targetOwner,
      actions: actions.data ?? [],
    });
  } catch (err) { next(err); }
});

router.patch('/reports/:id/status', async (req, res, next) => {
  try {
    const { status, reason } = req.body;
    if (!REPORT_STATUSES.has(status)) throw badRequest('Invalid report status');

    const { data, error } = await supabaseAdmin
      .from('reports')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Report not found' });

    const log = await logModerationAction({
      moderatorId: req.userId,
      targetType: data.target_type,
      targetId: data.target_id,
      action: status === 'dismissed' ? 'approve' : 'restore',
      reason: reason || `Report marked ${status}`,
    });

    res.json({ report: data, action: log });
  } catch (err) { next(err); }
});

router.post('/reports/:id/action', async (req, res, next) => {
  try {
    const { action, reason, resolve = true } = req.body;
    if (!action) throw badRequest('action required');

    const { data: report, error: reportError } = await supabaseAdmin
      .from('reports')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (reportError) throw reportError;
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const ownerId = await getTargetOwner(report.target_type, report.target_id);
    let target = null;

    if (CONTENT_ACTION_TO_STATUS[action]) {
      target = await applyContentStatus(report.target_type, report.target_id, CONTENT_ACTION_TO_STATUS[action]);
    } else if (USER_ACTIONS.has(action)) {
      if (!ownerId) throw badRequest('Cannot apply user action without a target owner');
      target = await applyUserAction(ownerId, action);
    } else {
      throw badRequest('Unsupported action');
    }

    const log = await logModerationAction({
      moderatorId: req.userId,
      targetType: report.target_type,
      targetId: report.target_id,
      action: action === 'remove' ? 'reject' : action,
      reason,
    });

    let updatedReport = report;
    if (resolve) {
      const { data, error } = await supabaseAdmin
        .from('reports')
        .update({
          status: action === 'approve' ? 'dismissed' : 'resolved',
          updated_at: new Date().toISOString(),
        })
        .eq('id', report.id)
        .select()
        .single();
      if (error) throw error;
      updatedReport = data;
    }

    if (ownerId && action !== 'approve' && action !== 'restore') {
      await notifyUserSafely(ownerId, {
        title: 'Content safety action',
        body: reason || 'An admin reviewed reported content and applied a safety action.',
        data: { reportId: report.id, targetType: report.target_type, targetId: report.target_id, action },
      });
    }

    res.json({ success: true, report: updatedReport, target, action: log });
  } catch (err) { next(err); }
});

router.get('/content', async (req, res, next) => {
  try {
    const { limit, offset, end } = parsePage(req.query);
    const { type = 'rating', status = 'all' } = req.query;
    const table = CONTENT_TABLES[type];
    if (!table) throw badRequest('type must be rating, comment, or story');

    let select = '*';
    if (type === 'rating') select = '*, profiles(id, name, username, profile_photo_url), dishes(id, name), restaurants(id, name, city)';
    if (type === 'comment') select = '*, profiles(id, name, username, profile_photo_url)';
    if (type === 'story') select = '*, profiles(id, name, username, profile_photo_url)';

    let query = supabaseAdmin
      .from(table)
      .select(select, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, end);
    if (status !== 'all') query = query.eq('content_status', status);

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ items: data ?? [], count: count ?? 0, limit, offset });
  } catch (err) { next(err); }
});

router.post('/content/:type/:id/action', async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const { action, reason } = req.body;
    const status = CONTENT_ACTION_TO_STATUS[action];
    if (!status) throw badRequest('action must be approve, restore, hide, reject, or remove');

    const target = await applyContentStatus(type, id, status);
    const log = await logModerationAction({
      moderatorId: req.userId,
      targetType: type,
      targetId: id,
      action: action === 'remove' ? 'reject' : action,
      reason,
    });

    res.json({ success: true, target, action: log });
  } catch (err) { next(err); }
});

router.get('/restaurants', async (req, res, next) => {
  try {
    const { limit, offset, end } = parsePage(req.query);
    const search = cleanSearch(req.query.q);
    const { status = 'all' } = req.query;

    let query = supabaseAdmin
      .from('restaurants')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, end);
    if (search) query = query.or(`name.ilike.%${search}%,city.ilike.%${search}%,cuisine.ilike.%${search}%`);
    if (status !== 'all') query = query.eq('catalog_status', status);

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ restaurants: data ?? [], count: count ?? 0, limit, offset });
  } catch (err) { next(err); }
});

router.patch('/restaurants/:id/status', async (req, res, next) => {
  try {
    const { status, reason } = req.body;
    if (!RESTAURANT_STATUSES.has(status)) throw badRequest('Invalid restaurant status');
    const { data, error } = await supabaseAdmin
      .from('restaurants')
      .update({ catalog_status: status })
      .eq('id', req.params.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Restaurant not found' });
    const log = await logModerationAction({
      moderatorId: req.userId,
      targetType: 'restaurant',
      targetId: req.params.id,
      action: status === 'hidden' ? 'hide' : 'restore',
      reason,
    });
    res.json({ restaurant: data, action: log });
  } catch (err) { next(err); }
});

router.get('/dishes', async (req, res, next) => {
  try {
    const { limit, offset, end } = parsePage(req.query);
    const search = cleanSearch(req.query.q);
    const { status = 'all' } = req.query;

    let query = supabaseAdmin
      .from('dishes')
      .select('*, restaurants(id, name, city)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, end);
    if (search) query = query.ilike('name', `%${search}%`);
    if (status !== 'all') query = query.eq('catalog_status', status);

    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ dishes: data ?? [], count: count ?? 0, limit, offset });
  } catch (err) { next(err); }
});

router.patch('/dishes/:id/status', async (req, res, next) => {
  try {
    const { status, reason } = req.body;
    if (!DISH_STATUSES.has(status)) throw badRequest('Invalid dish status');
    const { data, error } = await supabaseAdmin
      .from('dishes')
      .update({ catalog_status: status })
      .eq('id', req.params.id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Dish not found' });
    const log = await logModerationAction({
      moderatorId: req.userId,
      targetType: 'dish',
      targetId: req.params.id,
      action: status === 'hidden' ? 'hide' : 'restore',
      reason,
    });
    res.json({ dish: data, action: log });
  } catch (err) { next(err); }
});

router.get('/notifications', async (req, res, next) => {
  try {
    const { limit, offset, end } = parsePage(req.query);
    const { data, count, error } = await supabaseAdmin
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('event_type', 'admin_broadcast')
      .order('created_at', { ascending: false })
      .range(offset, end);
    if (error) throw error;
    res.json({ notifications: data ?? [], count: count ?? 0, limit, offset });
  } catch (err) { next(err); }
});

router.post('/notifications/broadcast', async (req, res, next) => {
  try {
    const { title, body, targetUserIds, reason } = req.body;
    if (!title || !body) throw badRequest('title and body required');

    let recipients = Array.isArray(targetUserIds) ? targetUserIds.filter(Boolean) : [];
    if (!recipients.length) {
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('account_status', 'active');
      if (error) throw error;
      recipients = (data ?? []).map(user => user.id);
    }

    let sent = 0;
    for (const userId of recipients) {
      try {
        await createNotification(supabaseAdmin, {
          userId,
          eventType: 'admin_broadcast',
          title,
          body,
          data: {
            source_id: `admin_${req.userId}_${Date.now()}_${userId}`,
            sent_by: req.userId,
            reason: reason ?? null,
          },
          push: true,
        });
        sent += 1;
      } catch (error) {
        console.error('[Admin] broadcast insert failed', { userId, message: error.message });
      }
    }

    const log = await logModerationAction({
      moderatorId: req.userId,
      targetType: 'user',
      targetId: req.userId,
      action: 'approve',
      reason: `Broadcast sent to ${sent}/${recipients.length}: ${title}`,
    });

    res.status(201).json({ success: true, sent, totalTargets: recipients.length, action: log });
  } catch (err) { next(err); }
});

router.get('/badges', async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('badges')
      .select('*')
      .order('name', { ascending: true });
    if (error) throw error;
    res.json({ badges: data ?? [] });
  } catch (err) { next(err); }
});

router.get('/challenges', async (_req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('challenges')
      .select('*')
      .order('start_date', { ascending: false });
    if (error) throw error;
    res.json({ challenges: data ?? [] });
  } catch (err) { next(err); }
});

router.get('/logs', async (req, res, next) => {
  try {
    const { limit, offset, end } = parsePage(req.query);
    const { data, count, error } = await supabaseAdmin
      .from('moderation_actions')
      .select('*, profiles(id, name, username, email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, end);
    if (error) throw error;
    res.json({ logs: data ?? [], count: count ?? 0, limit, offset });
  } catch (err) { next(err); }
});

router.get('/analytics', async (_req, res, next) => {
  try {
    const days = Array.from({ length: 30 }, (_, index) => {
      const end = new Date();
      end.setUTCHours(0, 0, 0, 0);
      end.setUTCDate(end.getUTCDate() - (29 - index));
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - 1);
      return { label: end.toISOString().slice(0, 10), start: start.toISOString(), end: end.toISOString() };
    });

    const [users, ratings, reports] = await Promise.all([
      Promise.all(days.map(day => countTable('profiles', q => q.gte('created_at', day.start).lt('created_at', day.end)))),
      Promise.all(days.map(day => countTable('ratings', q => q.gte('created_at', day.start).lt('created_at', day.end)))),
      Promise.all(days.map(day => countTable('reports', q => q.gte('created_at', day.start).lt('created_at', day.end)))),
    ]);

    res.json({
      days: days.map(day => day.label),
      newUsers: users,
      ratings,
      reports,
    });
  } catch (err) { next(err); }
});

export default router;
