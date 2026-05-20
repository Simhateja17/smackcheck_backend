import { Router } from 'express';

import authRoutes from './auth.js';
import restaurantRoutes from './restaurants.js';
import dishRoutes from './dishes.js';
import ratingRoutes from './ratings.js';
import likeRoutes from './likes.js';
import followerRoutes from './followers.js';
import commentRoutes from './comments.js';
import notificationRoutes from './notifications.js';
import storyRoutes from './stories.js';
import saveRoutes from './saves.js';
import visitRoutes from './visits.js';
import settingsRoutes from './settings.js';
import badgeRoutes from './badges.js';
import gamificationRoutes from './gamification.js';
import socialRoutes from './social.js';
import placesRoutes from './places.js';
import storageRoutes from './storage.js';
import moderationRoutes from './moderation.js';
import aiRoutes from './ai.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/restaurants', restaurantRoutes);
router.use('/dishes', dishRoutes);
router.use('/ratings', ratingRoutes);
router.use('/likes', likeRoutes);
router.use('/followers', followerRoutes);
router.use('/comments', commentRoutes);
router.use('/notifications', notificationRoutes);
router.use('/stories', storyRoutes);
router.use('/saves', saveRoutes);
router.use('/visits', visitRoutes);
router.use('/settings', settingsRoutes);
router.use('/badges', badgeRoutes);
router.use('/gamification', gamificationRoutes);
router.use('/social', socialRoutes);
router.use('/places', placesRoutes);
router.use('/storage', storageRoutes);
router.use('/moderation', moderationRoutes);
router.use('/ai', aiRoutes);

export default router;
