import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';

import { globalLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import router from './routes/index.js';

const app = express();

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ───────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use(globalLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api', router);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use(errorHandler);

const START_PORT = Number(process.env.PORT ?? 3000);
const MAX_PORT_ATTEMPTS = Number(process.env.PORT_ATTEMPTS ?? 25);

function listenOnAvailablePort(port, attemptsRemaining) {
  const server = app.listen(port, () => {
    console.log(`SmackCheck backend running on port ${port} [${process.env.NODE_ENV ?? 'development'}]`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && attemptsRemaining > 1) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is in use; trying ${nextPort}...`);
      listenOnAvailablePort(nextPort, attemptsRemaining - 1);
      return;
    }

    throw error;
  });
}

listenOnAvailablePort(START_PORT, MAX_PORT_ATTEMPTS);

export default app;
