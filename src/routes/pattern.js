import { Router } from 'express';
import pool from '../db/index.js';

const router = Router();

// --- Save Reference (competitor analysis result) ---
router.post('/references', async (req, res) => {
  try {
    const { url, title, keyword, category, char_count, image_count,
            subheadings, seo_score, geo_score, aeo_score } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO references_data (url, title, keyword, category,
        char_count, image_count, subheadings, seo_score, geo_score, aeo_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [url, title, keyword, category, char_count || 0, image_count || 0,
       JSON.stringify(subheadings || []), seo_score || 0, geo_score || 0, aeo_score || 0]
    );

    // Update pattern stats
    await updatePatternStats(category);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Reference List ---
router.get('/references', async (req, res) => {
  try {
    const { category, keyword } = req.query;
    let query = 'SELECT * FROM references_data';
    const params = [];
    const conditions = [];

    if (category) {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }
    if (keyword) {
      params.push(`%${keyword}%`);
      conditions.push(`keyword ILIKE $${params.length}`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY collected_at DESC LIMIT 100';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Pattern Stats by Category ---
router.get('/stats', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM pattern_stats ORDER BY sample_count DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Specific Category Pattern ---
router.get('/stats/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const stats = await pool.query(
      'SELECT * FROM pattern_stats WHERE category = $1', [category]
    );
    const refs = await pool.query(
      `SELECT url, title, keyword, char_count, image_count,
              seo_score, geo_score, aeo_score, collected_at
       FROM references_data WHERE category = $1
       ORDER BY (seo_score + geo_score + aeo_score) DESC LIMIT 10`,
      [category]
    );

    res.json({
      pattern: stats.rows[0] || null,
      topReferences: refs.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Feedback CRUD ---
router.post('/feedbacks', async (req, res) => {
  try {
    const { post_id, type, description, before_text, after_text } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO feedbacks (post_id, type, description, before_text, after_text)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [post_id, type, description, before_text, after_text]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/feedbacks/:id/apply', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE feedbacks SET applied = TRUE WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Feedback not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Internal: Recalculate pattern stats ---
async function updatePatternStats(category) {
  if (!category) return;
  try {
    await pool.query(`
      INSERT INTO pattern_stats (category, sample_count, avg_char_count, avg_image_count,
        avg_kw_repeat, avg_subheading_count, top_score, updated_at)
      SELECT
        category,
        COUNT(*),
        AVG(char_count),
        AVG(image_count),
        0,
        AVG(jsonb_array_length(subheadings)),
        MAX(seo_score + geo_score + aeo_score),
        NOW()
      FROM references_data
      WHERE category = $1
      GROUP BY category
      ON CONFLICT (category) DO UPDATE SET
        sample_count = EXCLUDED.sample_count,
        avg_char_count = EXCLUDED.avg_char_count,
        avg_image_count = EXCLUDED.avg_image_count,
        avg_subheading_count = EXCLUDED.avg_subheading_count,
        top_score = EXCLUDED.top_score,
        updated_at = NOW()
    `, [category]);
  } catch (err) {
    console.error('[Pattern] Stats update failed:', err.message);
  }
}

export default router;
