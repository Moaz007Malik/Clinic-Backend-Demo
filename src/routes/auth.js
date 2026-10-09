import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { adminQuery, adminTx } from '../db.js';
import { asyncRoute, HttpError, assertPasswordPolicy, slugify } from '../http.js';
import {
  buildTotp,
  forgetAuth,
  hashPassword,
  newMfaSecret,
  openSession,
  recordFailure,
  requireAuth,
  verifyPassword
} from '../auth.js';

const router = Router();

const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Wait a few minutes and try again.' }
});

router.get('/public/tenants/:slug', asyncRoute(async (req, res) => {
  const { rows } = await adminQuery(`SELECT * FROM public_branding($1)`, [req.params.slug]);
  if (!rows[0]) throw new HttpError(404, 'Clinic not found.');
  res.json({ tenant: rows[0] });
}));

router.post('/auth/login', loginLimit, asyncRoute(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const slug = String(req.body?.slug || '').trim().toLowerCase() || null;
  const otp = String(req.body?.otp || '').trim();
  if (!email || !password) throw new HttpError(400, 'Email and password are required.');

  const { rows } = await adminQuery(`SELECT * FROM auth_lookup($1, $2)`, [email, slug]);
  const user = rows[0];
  const valid = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !valid) {
    await recordFailure(req, email, 'invalid_credentials', user);
    throw new HttpError(401, 'Email, clinic code, or password is incorrect.');
  }
  if (user.status !== 'active') {
    await recordFailure(req, email, 'disabled', user);
    throw new HttpError(403, 'This account is disabled.');
  }
  if (user.org_status && ['suspended', 'inactive'].includes(user.org_status)) {
    await recordFailure(req, email, 'org_inactive', user);
    throw new HttpError(403, 'This organization is not active. Contact the platform owner.');
  }
  if (user.mfa_enabled) {
    if (!otp) throw new HttpError(401, 'Enter the authentication code.', { mfaRequired: true });
    const totp = buildTotp(user.email, user.mfa_secret);
    const delta = totp.validate({ token: otp, window: 1 });
    if (delta === null) {
      await recordFailure(req, email, 'bad_otp', user);
      throw new HttpError(401, 'Authentication code is incorrect.', { mfaRequired: true });
    }
  }

  const session = await openSession(user, req);
  res.json({ token: session.token, expiresAt: session.expiresAt });
}));

router.post('/auth/onboard', loginLimit, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const name = String(body.organizationName || '').trim();
  const slug = slugify(body.slug || name);
  const adminName = String(body.adminName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const clinicName = String(body.clinicName || '').trim() || `${name} Clinic`;
  if (name.length < 2 || slug.length < 3) throw new HttpError(400, 'Organization name and a clinic code of at least 3 characters are required.');
  if (!adminName || !email.includes('@')) throw new HttpError(400, 'An administrator name and email are required.');
  assertPasswordPolicy(password);

  const result = await adminTx(async (client) => {
    const plan = await client.query(`SELECT id FROM subscription_plans WHERE key = 'starter'`);
    const role = await client.query(`SELECT id FROM roles WHERE key = 'org_admin' AND organization_id IS NULL`);
    if (!plan.rowCount || !role.rowCount) {
      throw new HttpError(500, 'Subscription plans are not ready. Run the database setup first.');
    }
    const taken = await client.query(`SELECT 1 FROM organizations WHERE slug = $1`, [slug]);
    if (taken.rowCount) throw new HttpError(409, 'That clinic code is already in use.');

    const org = await client.query(
      `INSERT INTO organizations (name, legal_name, slug, status, primary_color, accent_color, email, phone, address, city, country, timezone)
       VALUES ($1, $2, $3, 'trial', $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        name,
        body.legalName || name,
        slug,
        body.primaryColor || '#1c6b52',
        body.accentColor || '#c56a32',
        email,
        body.phone || null,
        body.address || null,
        body.city || null,
        body.country || null,
        body.timezone || 'Asia/Muscat'
      ]
    );
    const organization = org.rows[0];
    const trialEnd = new Date(Date.now() + 14 * 86400000);
    await client.query(
      `INSERT INTO subscriptions (organization_id, plan_id, status, billing_cycle, trial_ends_at, current_period_end)
       VALUES ($1, $2, 'trialing', 'monthly', $3, $3)`,
      [organization.id, plan.rows[0].id, trialEnd]
    );
    const clinic = await client.query(
      `INSERT INTO clinics (organization_id, name, code, phone, email, address, city, timezone, is_primary)
       VALUES ($1, $2, 'MAIN', $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [organization.id, clinicName, body.phone || null, email, body.address || null, body.city || null, organization.timezone]
    );
    const passwordHash = await hashPassword(password);
    const user = await client.query(
      `INSERT INTO users (organization_id, clinic_id, role_id, email, password_hash, full_name, phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, full_name, organization_id`,
      [organization.id, clinic.rows[0].id, role.rows[0].id, email, passwordHash, adminName, body.phone || null]
    );
    await client.query(
      `INSERT INTO user_clinics (user_id, clinic_id, organization_id) VALUES ($1, $2, $3)`,
      [user.rows[0].id, clinic.rows[0].id, organization.id]
    );
    await client.query(
      `INSERT INTO departments (organization_id, clinic_id, name, code) VALUES ($1, $2, 'General Medicine', 'GM')`,
      [organization.id, clinic.rows[0].id]
    );
    await client.query(
      `INSERT INTO services (organization_id, name, category, base_price, duration_minutes)
       VALUES ($1, 'General consultation', 'consultation', 2500, 20)`,
      [organization.id]
    );
    for (let day = 0; day < 7; day += 1) {
      const closed = day === 0;
      await client.query(
        `INSERT INTO working_hours (organization_id, clinic_id, weekday, opens, closes, is_closed)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [organization.id, clinic.rows[0].id, day, closed ? null : '08:00', closed ? null : '18:00', closed]
      );
    }
    await client.query(
      `INSERT INTO activity_logs (organization_id, user_id, action, entity, entity_id, ip)
       VALUES ($1, $2, 'organization.onboarded', 'organizations', $1, $3)`,
      [organization.id, user.rows[0].id, req.ip]
    );
    return user.rows[0];
  });

  const session = await openSession({ ...result, organization_id: result.organization_id }, req);
  res.status(201).json({ token: session.token, slug });
}));

router.post('/auth/logout', requireAuth, asyncRoute(async (req, res) => {
  const header = req.get('authorization') || '';
  forgetAuth(header.startsWith('Bearer ') ? header.slice(7) : '');
  await adminQuery(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [req.user.sessionId]);
  res.json({ ok: true });
}));

router.get('/auth/me', requireAuth, asyncRoute(async (req, res) => {
  let clinics = [];
  let subscription = null;
  let unread = 0;
  if (!req.user.isSuper && req.user.organizationId) {
    const { rows } = await adminQuery(
      `SELECT
         COALESCE((
           SELECT json_agg(json_build_object(
             'id', c.id, 'name', c.name, 'code', c.code, 'city', c.city,
             'is_primary', c.is_primary, 'status', c.status, 'phone', c.phone, 'address', c.address
           ) ORDER BY c.is_primary DESC, c.name)
           FROM clinics c
           WHERE c.organization_id = $1 AND ($2::boolean OR c.id = ANY($3::uuid[]))
         ), '[]'::json) AS clinics,
         (
           SELECT json_build_object(
             'id', s.id, 'organization_id', s.organization_id, 'plan_id', s.plan_id, 'status', s.status,
             'billing_cycle', s.billing_cycle, 'trial_ends_at', s.trial_ends_at, 'current_period_end', s.current_period_end,
             'plan_key', p.key, 'plan_name', p.name, 'price_monthly', p.price_monthly, 'price_yearly', p.price_yearly,
             'max_users', p.max_users, 'max_patients', p.max_patients, 'max_branches', p.max_branches,
             'max_storage_mb', p.max_storage_mb, 'sms_quota', p.sms_quota, 'whatsapp_quota', p.whatsapp_quota, 'features', p.features
           )
           FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
           WHERE s.organization_id = $1
         ) AS subscription,
         (
           SELECT count(*)::int FROM notifications
           WHERE organization_id = $1 AND channel = 'in_app' AND read_at IS NULL
             AND (user_id = $4 OR ($5::uuid IS NOT NULL AND patient_id = $5))
         ) AS unread`,
      [req.user.organizationId, req.user.allClinics, req.user.clinicIds, req.user.id, req.user.patientId]
    );
    clinics = rows[0]?.clinics || [];
    subscription = rows[0]?.subscription || null;
    unread = rows[0]?.unread || 0;
  }

  res.json({
    user: {
      id: req.user.id,
      fullName: req.user.fullName,
      email: req.user.email,
      phone: req.user.phone,
      roleKey: req.user.roleKey,
      roleName: req.user.roleName,
      patientId: req.user.patientId,
      clinicId: req.clinicId,
      isSuper: req.user.isSuper,
      mfaEnabled: req.user.mfaEnabled,
      permissions: req.user.permissions,
      allClinics: req.user.allClinics
    },
    organization: req.organization,
    clinics,
    subscription,
    unread
  });
}));

router.post('/auth/mfa/setup', requireAuth, asyncRoute(async (req, res) => {
  const secret = newMfaSecret();
  await adminQuery(`UPDATE users SET mfa_secret = $1, mfa_enabled = false WHERE id = $2`, [secret, req.user.id]);
  const totp = buildTotp(req.user.email, secret);
  res.json({ secret, uri: totp.toString() });
}));

router.post('/auth/mfa/enable', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await adminQuery(`SELECT email, mfa_secret FROM users WHERE id = $1`, [req.user.id]);
  const user = rows[0];
  if (!user?.mfa_secret) throw new HttpError(400, 'Start MFA setup first.');
  const delta = buildTotp(user.email, user.mfa_secret).validate({ token: String(req.body?.otp || ''), window: 1 });
  if (delta === null) throw new HttpError(400, 'Authentication code is incorrect.');
  await adminQuery(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [req.user.id]);
  res.json({ enabled: true });
}));

router.post('/auth/mfa/disable', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await adminQuery(`SELECT password_hash, mfa_secret, mfa_enabled, email FROM users WHERE id = $1`, [req.user.id]);
  const user = rows[0];
  const valid = await verifyPassword(String(req.body?.password || ''), user.password_hash);
  if (!valid) throw new HttpError(401, 'Password is incorrect.');
  if (user.mfa_enabled) {
    const delta = buildTotp(user.email, user.mfa_secret).validate({ token: String(req.body?.otp || ''), window: 1 });
    if (delta === null) throw new HttpError(401, 'Authentication code is incorrect.');
  }
  await adminQuery(`UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1`, [req.user.id]);
  res.json({ enabled: false });
}));

export default router;
