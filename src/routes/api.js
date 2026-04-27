import { Router } from 'express';
import pool from '../db/index.js';

const router = Router();

// --- Post List ---
router.get('/posts', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM tracked_posts ORDER BY created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Create/Update Post ---
router.post('/posts', async (req, res) => {
  try {
    const { url, title, keyword, category, platform, char_count, image_count,
            seo_score, geo_score, aeo_score, total_score } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO tracked_posts (url, title, keyword, category, platform,
        char_count, image_count, seo_score, geo_score, aeo_score, total_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (url) DO UPDATE SET
         title = EXCLUDED.title,
         seo_score = EXCLUDED.seo_score,
         geo_score = EXCLUDED.geo_score,
         aeo_score = EXCLUDED.aeo_score,
         total_score = EXCLUDED.total_score,
         updated_at = NOW()
       RETURNING *`,
      [url, title, keyword, category || 'general', platform || 'blog',
       char_count || 0, image_count || 0,
       seo_score || 0, geo_score || 0, aeo_score || 0, total_score || 0]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Post Detail + Rankings ---
router.get('/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const post = await pool.query('SELECT * FROM tracked_posts WHERE id = $1', [id]);
    if (post.rows.length === 0) return res.status(404).json({ error: 'Post not found' });

    const rankings = await pool.query(
      'SELECT * FROM ranking_records WHERE post_id = $1 ORDER BY checked_at DESC LIMIT 30',
      [id]
    );
    const views = await pool.query(
      'SELECT * FROM view_records WHERE post_id = $1 ORDER BY recorded_at DESC LIMIT 30',
      [id]
    );
    const feedbacks = await pool.query(
      'SELECT * FROM feedbacks WHERE post_id = $1 ORDER BY created_at DESC',
      [id]
    );

    res.json({
      ...post.rows[0],
      rankings: rankings.rows,
      views: views.rows,
      feedbacks: feedbacks.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Delete Post ---
router.delete('/posts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tracked_posts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Add Ranking Record ---
router.post('/rankings', async (req, res) => {
  try {
    const { post_id, keyword, position, page, search_type } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO ranking_records (post_id, keyword, position, page, search_type)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [post_id, keyword, position, page || 1, search_type || 'blog']
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Add View Record ---
router.post('/views', async (req, res) => {
  try {
    const { post_id, views } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO view_records (post_id, views) VALUES ($1,$2) RETURNING *',
      [post_id, views]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Dashboard Stats ---
router.get('/stats', async (req, res) => {
  try {
    const totalPosts = await pool.query('SELECT COUNT(*) FROM tracked_posts');
    const avgScore = await pool.query('SELECT AVG(total_score) as avg FROM tracked_posts');
    const recentRankings = await pool.query(
      `SELECT r.*, t.title, t.keyword
       FROM ranking_records r
       JOIN tracked_posts t ON r.post_id = t.id
       ORDER BY r.checked_at DESC LIMIT 10`
    );
    const pendingFeedbacks = await pool.query(
      'SELECT COUNT(*) FROM feedbacks WHERE applied = FALSE'
    );

    res.json({
      totalPosts: parseInt(totalPosts.rows[0].count),
      avgScore: parseFloat(avgScore.rows[0].avg || 0).toFixed(1),
      recentRankings: recentRankings.rows,
      pendingFeedbacks: parseInt(pendingFeedbacks.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
