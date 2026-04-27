import { Router } from 'express';
import pool from '../db/index.js';

const router = Router();

// --- Ranking Dashboard Data ---
router.get('/dashboard', async (req, res) => {
  try {
    const { period } = req.query; // day, week, month
    let interval = '7 days';
    if (period === 'day') interval = '1 day';
    if (period === 'month') interval = '30 days';

    // Ranking changes within period
    const rankings = await pool.query(`
      SELECT r.keyword, r.position, r.checked_at, t.title, t.url
      FROM ranking_records r
      JOIN tracked_posts t ON r.post_id = t.id
      WHERE r.checked_at >= NOW() - $1::interval
      ORDER BY r.checked_at DESC
    `, [interval]);

    // View trends within period
    const views = await pool.query(`
      SELECT v.post_id, v.views, v.recorded_at, t.title
      FROM view_records v
      JOIN tracked_posts t ON v.post_id = t.id
      WHERE v.recorded_at >= NOW() - $1::interval
      ORDER BY v.recorded_at DESC
    `, [interval]);

    // Latest ranking per post
    const latestRankings = await pool.query(`
      SELECT DISTINCT ON (r.post_id, r.keyword)
        r.post_id, r.keyword, r.position, r.checked_at, t.title
      FROM ranking_records r
      JOIN tracked_posts t ON r.post_id = t.id
      ORDER BY r.post_id, r.keyword, r.checked_at DESC
    `);

    // Total views sum
    const totalViews = await pool.query(`
      SELECT COALESCE(SUM(views), 0) as total
      FROM view_records
      WHERE recorded_at >= NOW() - $1::interval
    `, [interval]);

    res.json({
      period,
      rankings: rankings.rows,
      views: views.rows,
      latestRankings: latestRankings.rows,
      totalViews: parseInt(totalViews.rows[0].total)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Post Ranking History ---
router.get('/history/:postId', async (req, res) => {
  try {
    const { postId } = req.params;
    const rankings = await pool.query(
      `SELECT keyword, position, page, checked_at
       FROM ranking_records WHERE post_id = $1
       ORDER BY checked_at ASC`,
      [postId]
    );
    const views = await pool.query(
      `SELECT views, recorded_at
       FROM view_records WHERE post_id = $1
       ORDER BY recorded_at ASC`,
      [postId]
    );
    res.json({ rankings: rankings.rows, views: views.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Ranking Change Alerts ---
router.get('/alerts', async (req, res) => {
  try {
    // Compare last 2 rankings, show changes >= 3 positions
    const alerts = await pool.query(`
      WITH ranked AS (
        SELECT post_id, keyword, position,
          LAG(position) OVER (PARTITION BY post_id, keyword ORDER BY checked_at) as prev_position,
          checked_at
        FROM ranking_records
      )
      SELECT r.*, t.title, t.url
      FROM ranked r
      JOIN tracked_posts t ON r.post_id = t.id
      WHERE r.prev_position IS NOT NULL
        AND ABS(r.position - r.prev_position) >= 3
      ORDER BY r.checked_at DESC
      LIMIT 20
    `);

    res.json(alerts.rows.map(a => ({
      ...a,
      change: a.prev_position - a.position, // positive = up, negative = down
      direction: a.prev_position > a.position ? 'up' : 'down'
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
