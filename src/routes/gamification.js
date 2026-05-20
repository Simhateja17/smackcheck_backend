/**
 * /api/gamification — points, challenges, streaks, leaderboard
 */
import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── Points / XP ───────────────────────────────────────────────────────────────

// POST /api/gamification/record-action — record a user action and award XP
router.post('/record-action', requireAuth, async (req, res, next) => {
  try {
    const { action_type, points_earned, metadata } = req.body;
    if (!action_type || points_earned == null) {
      return res.status(400).json({ error: 'action_type and points_earned required' });
    }

    // Insert action
    const { error: actionErr } = await supabaseAdmin.from('user_actions').insert({
      user_id: req.userId,
      action_type,
      points_earned: parseInt(points_earned),
      metadata: metadata ?? {},
    });
    if (actionErr) throw actionErr;

    // Update profile totals
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('total_points, xp, level')
      .eq('id', req.userId)
      .single();

    const newTotal = (profile?.total_points ?? 0) + parseInt(points_earned);
    const newXp = (profile?.xp ?? 0) + parseInt(points_earned);
    const newLevel = Math.floor(newXp / 100) + 1;

    await supabaseAdmin.from('profiles').update({
      total_points: newTotal,
      xp: newXp,
      level: newLevel,
      updated_at: new Date().toISOString(),
    }).eq('id', req.userId);

    res.json({ total_points: newTotal, xp: newXp, level: newLevel });
  } catch (err) { next(err); }
});

// GET /api/gamification/leaderboard?limit=20
router.get('/leaderboard', requireAuth, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit ?? '20', 10);
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, name, username, profile_photo_url, total_points, current_streak, longest_streak, level')
      .order('total_points', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/gamification/my-rank
router.get('/my-rank', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, total_points')
      .order('total_points', { ascending: false })
      .limit(200);
    if (error) throw error;
    const rank = data.findIndex(p => p.id === req.userId) + 1;
    res.json({ rank: rank > 0 ? rank : data.length + 1 });
  } catch (err) { next(err); }
});

// GET /api/gamification/actions/count?actionType=...&since=YYYY-MM-DD
router.get('/actions/count', requireAuth, async (req, res, next) => {
  try {
    const { actionType, since } = req.query;
    if (!actionType || !since) return res.status(400).json({ error: 'actionType and since required' });
    const { data, error } = await supabaseAdmin
      .from('user_actions')
      .select('id')
      .eq('user_id', req.userId)
      .eq('action_type', actionType)
      .gte('created_at', `${since}T00:00:00Z`);
    if (error) throw error;
    res.json({ count: data.length });
  } catch (err) { next(err); }
});

// ── Streaks ───────────────────────────────────────────────────────────────────

// POST /api/gamification/update-streak — calculate & update streak
router.post('/update-streak', requireAuth, async (req, res, next) => {
  try {
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('current_streak, longest_streak, last_active_date, total_points')
      .eq('id', req.userId)
      .single();
    if (error) throw error;

    const today = new Date().toISOString().split('T')[0];
    const lastDate = profile?.last_active_date;
    let { current_streak = 0, longest_streak = 0 } = profile ?? {};
    let bonusXp = 0;

    if (lastDate === today) {
      // Same day — no change
    } else if (lastDate) {
      const diff = (new Date(today) - new Date(lastDate)) / 86400000;
      if (diff === 1) {
        current_streak += 1;
      } else {
        current_streak = 1;
      }
    } else {
      current_streak = 1;
    }

    if (current_streak > longest_streak) longest_streak = current_streak;

    // Milestone bonuses
    const milestones = { 3: 20, 7: 50 };
    for (const [days, xp] of Object.entries(milestones)) {
      if (current_streak === parseInt(days)) {
        // Check if reward already given today
        const { data: existing } = await supabaseAdmin
          .from('streak_rewards')
          .select('id')
          .eq('user_id', req.userId)
          .eq('streak_days', parseInt(days))
          .gte('awarded_at', `${today}T00:00:00Z`)
          .maybeSingle();
        if (!existing) {
          bonusXp += xp;
          await supabaseAdmin.from('streak_rewards').insert({
            user_id: req.userId,
            streak_days: parseInt(days),
            points_earned: xp,
            awarded_at: new Date().toISOString(),
          });
        }
      }
    }

    const updates = {
      current_streak,
      longest_streak,
      streak_count: current_streak,
      last_active_date: today,
      updated_at: new Date().toISOString(),
    };
    if (bonusXp > 0) {
      updates.total_points = (profile?.total_points ?? 0) + bonusXp;
    }

    await supabaseAdmin.from('profiles').update(updates).eq('id', req.userId);
    res.json({ current_streak, longest_streak, bonus_xp: bonusXp });
  } catch (err) { next(err); }
});

// ── Challenges ────────────────────────────────────────────────────────────────

// GET /api/gamification/challenges
router.get('/challenges', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('challenges')
      .select('*')
      .eq('is_active', true);
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/gamification/challenges/progress — user's progress on all challenges
router.get('/challenges/progress', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('user_challenges')
      .select('*, challenges(*)')
      .eq('user_id', req.userId);
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/gamification/challenges/increment — increment progress for a challenge action
router.post('/challenges/increment', requireAuth, async (req, res, next) => {
  try {
    const { action_type } = req.body;
    if (!action_type) return res.status(400).json({ error: 'action_type required' });

    // Get active challenges matching this action type
    const { data: challenges, error: cErr } = await supabaseAdmin
      .from('challenges')
      .select('*')
      .eq('is_active', true);
    if (cErr) throw cErr;

    const today = new Date().toISOString().split('T')[0];
    let totalBonusXp = 0;

    for (const challenge of challenges) {
      const periodStart = challenge.challenge_type === 'daily' ? today : getWeekStart();

      // Get or create progress
      let { data: progress } = await supabaseAdmin
        .from('user_challenges')
        .select('*')
        .eq('user_id', req.userId)
        .eq('challenge_id', challenge.id)
        .eq('started_at', `${periodStart}T00:00:00Z`)
        .maybeSingle();

      if (!progress) {
        const { data: created } = await supabaseAdmin
          .from('user_challenges')
          .insert({ user_id: req.userId, challenge_id: challenge.id, progress: 0, is_completed: false, started_at: `${periodStart}T00:00:00Z` })
          .select().single();
        progress = created;
      }

      if (!progress || progress.is_completed) continue;

      const newProgress = progress.progress + 1;
      const completed = newProgress >= challenge.target_count;
      await supabaseAdmin.from('user_challenges').update({
        progress: newProgress,
        is_completed: completed,
        completed_at: completed ? new Date().toISOString() : null,
      }).eq('id', progress.id);

      if (completed) totalBonusXp += challenge.xp_reward;
    }

    res.json({ bonus_xp: totalBonusXp });
  } catch (err) { next(err); }
});

function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return d.toISOString().split('T')[0];
}

export default router;
