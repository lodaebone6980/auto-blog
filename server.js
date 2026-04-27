import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB, pool } from './src/db/index.js';
import apiRouter from './src/routes/api.js';
import aiRouter from './src/routes/ai.js';
import trackRouter from './src/routes/track.js';
import patternRouter from './src/routes/pattern.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors({
  origin: [
    'chrome-extension://*',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));

// --- API Routes ---
app.use('/api', apiRouter);
app.use('/api/ai', aiRouter);
app.use('/api/track', trackRouter);
app.use('/api/pattern', patternRouter);

// --- Health Check ---
app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW()');
    res.json({
      status: 'ok',
      timestamp: dbResult.rows[0].now,
      version: '1.0.0',
      service: 'auto-blog'
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// --- Serve built frontend ---
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- Start Server ---
async function start() {
  try {
    await initDB();
    console.log('[auto-blog] DB initialized');
  } catch (err) {
    console.error('[auto-blog] DB init failed (server continues):', err.message);
  }

  app.listen(PORT, () => {
    console.log(`[auto-blog] Server running: http://localhost:${PORT}`);
  });
}

start();
