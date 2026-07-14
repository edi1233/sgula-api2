const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error('ADMIN_PASSWORD and SESSION_SECRET must be set');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const CITIES = new Set(['ariel', 'hadera']);
const TREATMENTS = new Set(['combined', 'deep-tissue', 'lomi-lomi', 'thai-combo']);
const DURATIONS = new Set([60, 75, 90]);
const STATUSES = new Set(['pending', 'confirmed', 'declined', 'completed', 'cancelled']);

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      city TEXT NOT NULL,
      treatment TEXT NOT NULL,
      appt_date DATE NOT NULL,
      appt_time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 60;`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS appointments_active_slot_idx
    ON appointments (city, appt_date, appt_time)
    WHERE status IN ('pending', 'confirmed');
  `);
}

async function migrateWithRetry() {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await migrate();
      console.log('migration ok');
      return;
    } catch (err) {
      console.error(`migration attempt ${attempt} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.error('migration failed after retries, exiting');
  process.exit(1);
}

function signSession(expiry) {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(String(expiry)).digest('hex');
  return `${expiry}.${hmac}`;
}

function verifySession(token) {
  if (!token) return false;
  const [expiryStr, sig] = String(token).split('.');
  if (!expiryStr || !sig) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(expiryStr).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  return Number(expiryStr) > Date.now();
}

function requireAdmin(req, res, next) {
  if (verifySession(req.cookies.sgula_admin)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

const app = express();
app.use(express.json());
app.use(cookieParser());

app.post('/api/appointments', async (req, res) => {
  const { name, phone, city, treatment, date, time, duration, note } = req.body || {};
  const durationMinutes = Number(duration || 60);
  if (
    typeof name !== 'string' || !name.trim() ||
    typeof phone !== 'string' || !phone.trim() ||
    !CITIES.has(city) ||
    !TREATMENTS.has(treatment) ||
    !DURATIONS.has(durationMinutes) ||
    typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time)
  ) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const safeNote = typeof note === 'string' ? note.slice(0, 500) : null;
  try {
    const result = await pool.query(
      `INSERT INTO appointments (name, phone, city, treatment, appt_date, appt_time, duration_minutes, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [name.trim().slice(0, 120), phone.trim().slice(0, 40), city, treatment, date, time, durationMinutes, safeNote]
    );
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'slot_taken' });
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const pwBuf = Buffer.from(String(password || ''));
  const expectedBuf = Buffer.from(ADMIN_PASSWORD);
  const match = pwBuf.length === expectedBuf.length && crypto.timingSafeEqual(pwBuf, expectedBuf);
  if (!match) return res.status(401).json({ error: 'invalid_password' });
  const expiry = Date.now() + SESSION_TTL_MS;
  const token = signSession(expiry);
  res.cookie('sgula_admin', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('sgula_admin', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: verifySession(req.cookies.sgula_admin) });
});

app.get('/api/admin/appointments', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, city, treatment, appt_date, appt_time, duration_minutes, note, status, created_at
       FROM appointments ORDER BY appt_date ASC, appt_time ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.patch('/api/admin/appointments/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!Number.isInteger(id) || !STATUSES.has(status)) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    const result = await pool.query(
      `UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id`,
      [status, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/admin/appointments/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_input' });
  try {
    await pool.query(`DELETE FROM appointments WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

migrateWithRetry().then(() => {
  app.listen(PORT, () => console.log(`sgula-api listening on ${PORT}`));
});
