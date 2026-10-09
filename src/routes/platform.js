import { Router } from 'express';
import { q, tx } from '../db.js';
import { BACKUP_TABLES, PERMISSIONS, ROLE_NAMES } from '../catalog.js';
import { asyncRoute, HttpError, assertPasswordPolicy } from '../http.js';
import { hashPassword, requireAuth, requirePermission } from '../auth.js';
import { assertClinic, assertDepartment, audit, guardSubscription, requireOrg } from '../scope.js';
import { adminQuery } from '../db.js';

const router = Router();
router.use(requireAuth);

router.get('/dashboard', requirePermission('reports.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const clinic = req.clinicId;
  const { rows } = await q(
    req,
    `SELECT
       (SELECT count(*)::int FROM patients WHERE organization_id = $1 AND ($2::uuid IS NULL OR clinic_id = $2)) AS patients,
       (SELECT count(*)::int FROM appointments WHERE organization_id = $1 AND ($2::uuid IS NULL OR clinic_id = $2)
          AND (starts_at AT TIME ZONE 'Asia/Muscat')::date = (now() AT TIME ZONE 'Asia/Muscat')::date) AS appointments_today,
       (SELECT COALESCE(SUM(CASE WHEN kind = 'payment' THEN amount ELSE -amount END), 0)::float FROM payments
          WHERE organization_id = $1 AND (received_at AT TIME ZONE 'Asia/Muscat')::date = (now() AT TIME ZONE 'Asia/Muscat')::date) AS revenue_today,
       (SELECT COALESCE(SUM(balance), 0)::float FROM invoices WHERE organization_id = $1 AND status IN ('open', 'partial')) AS outstanding,
       (SELECT COALESCE(json_agg(d ORDER BY d.visits DESC), '[]'::json) FROM (
          SELECT u.full_name,
                 (SELECT count(*)::int FROM appointments a WHERE a.doctor_id = u.id
                    AND (a.starts_at AT TIME ZONE 'Asia/Muscat')::date = (now() AT TIME ZONE 'Asia/Muscat')::date) AS visits,
                 (SELECT count(*)::int FROM appointments a WHERE a.doctor_id = u.id AND a.status = 'completed'
                    AND (a.starts_at AT TIME ZONE 'Asia/Muscat')::date = (now() AT TIME ZONE 'Asia/Muscat')::date) AS completed,
                 COALESCE((SELECT SUM(i.total * COALESCE(sp.commission_percent, 0) / 100)
                    FROM invoices i WHERE i.doctor_id = u.id AND i.status = 'paid'), 0)::float AS commission
          FROM users u
          JOIN roles r ON r.id = u.role_id AND r.key = 'doctor'
          LEFT JOIN staff_profiles sp ON sp.user_id = u.id
          WHERE u.organization_id = $1
       ) d) AS doctors,
       (SELECT count(*)::int FROM lab_orders WHERE organization_id = $1 AND ordered_at::date = CURRENT_DATE) AS lab_orders,
       (SELECT count(*)::int FROM lab_orders WHERE organization_id = $1 AND ordered_at::date = CURRENT_DATE AND status IN ('resulted', 'approved')) AS lab_reported,
       (SELECT COALESCE(SUM(total), 0)::float FROM invoices WHERE organization_id = $1 AND category = 'pharmacy' AND issued_at::date = CURRENT_DATE) AS pharmacy_sales,
       (SELECT count(*)::int FROM (
          SELECT m.id FROM medicines m LEFT JOIN stock_batches b ON b.medicine_id = m.id
          WHERE m.organization_id = $1 GROUP BY m.id, m.reorder_level
          HAVING COALESCE(SUM(b.quantity), 0) <= m.reorder_level
       ) s) AS low_stock,
       (SELECT count(*)::int FROM patients WHERE organization_id = $1 AND created_at > now() - interval '7 days') AS new_patients,
       (SELECT count(*)::int FROM encounters WHERE organization_id = $1 AND follow_up_on >= (now() AT TIME ZONE 'Asia/Muscat')::date AND follow_up_on < (now() AT TIME ZONE 'Asia/Muscat')::date + 7) AS follow_ups,
       (SELECT count(*)::int FROM appointments WHERE organization_id = $1 AND ($2::uuid IS NULL OR clinic_id = $2) AND status = 'no_show'
          AND (starts_at AT TIME ZONE 'Asia/Muscat')::date = (now() AT TIME ZONE 'Asia/Muscat')::date) AS no_shows,
       (SELECT count(*)::int FROM appointments WHERE organization_id = $1 AND ($2::uuid IS NULL OR clinic_id = $2) AND status IN ('checked_in', 'in_consult')
          AND (starts_at AT TIME ZONE 'Asia/Muscat')::date = (now() AT TIME ZONE 'Asia/Muscat')::date) AS in_queue,
       (SELECT count(*)::int FROM invoices WHERE organization_id = $1 AND status IN ('open', 'partial')) AS open_invoices,
       (SELECT count(*)::int FROM claims WHERE organization_id = $1 AND status = 'submitted') AS claims_pending,
       (SELECT count(*)::int FROM beds WHERE organization_id = $1 AND ($2::uuid IS NULL OR clinic_id = $2) AND status = 'occupied') AS beds_occupied,
       (SELECT count(*)::int FROM beds WHERE organization_id = $1 AND ($2::uuid IS NULL OR clinic_id = $2) AND status <> 'maintenance') AS beds_ready,
       (SELECT COALESCE(json_agg(s ORDER BY s.starts_at), '[]'::json) FROM (
          SELECT a.id, a.starts_at, a.status, a.visit_type, a.token_number, a.reason,
                 p.first_name, p.last_name, p.mrn, u.full_name AS doctor_name
          FROM appointments a
          JOIN patients p ON p.id = a.patient_id
          LEFT JOIN users u ON u.id = a.doctor_id
          WHERE a.organization_id = $1 AND ($2::uuid IS NULL OR a.clinic_id = $2)
            AND (a.starts_at AT TIME ZONE 'Asia/Muscat')::date = (now() AT TIME ZONE 'Asia/Muscat')::date
          ORDER BY a.starts_at LIMIT 12
       ) s) AS schedule,
       (SELECT COALESCE(json_agg(e ORDER BY e.expiry_on), '[]'::json) FROM (
          SELECT m.name, b.batch_no, b.expiry_on, b.quantity
          FROM stock_batches b JOIN medicines m ON m.id = b.medicine_id
          WHERE b.organization_id = $1 AND b.quantity > 0 AND b.expiry_on < CURRENT_DATE + 90
          ORDER BY b.expiry_on LIMIT 6
       ) e) AS expiring,
       (SELECT COALESCE(json_agg(w ORDER BY w.day), '[]'::json) FROM (
          SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
            (SELECT count(*)::int FROM appointments a
              WHERE a.organization_id = $1 AND ($2::uuid IS NULL OR a.clinic_id = $2)
                AND (a.starts_at AT TIME ZONE 'Asia/Muscat')::date = d::date) AS visits,
            (SELECT COALESCE(SUM(CASE WHEN kind = 'payment' THEN amount ELSE -amount END), 0)::float FROM payments p
              WHERE p.organization_id = $1
                AND (p.received_at AT TIME ZONE 'Asia/Muscat')::date = d::date) AS revenue
          FROM generate_series((now() AT TIME ZONE 'Asia/Muscat')::date - 13, (now() AT TIME ZONE 'Asia/Muscat')::date, interval '1 day') d
       ) w) AS trend,
       (SELECT COALESCE(json_agg(h ORDER BY h.hour), '[]'::json) FROM (
          SELECT gs AS hour,
            (SELECT count(*)::int FROM appointments a
              WHERE a.organization_id = $1 AND ($2::uuid IS NULL OR a.clinic_id = $2)
                AND (a.starts_at AT TIME ZONE 'Asia/Muscat')::date = (now() AT TIME ZONE 'Asia/Muscat')::date
                AND EXTRACT(HOUR FROM a.starts_at AT TIME ZONE 'Asia/Muscat') = gs) AS visits
          FROM generate_series(8, 19) gs
       ) h) AS hours,
       (SELECT COALESCE(json_agg(st ORDER BY st.value DESC), '[]'::json) FROM (
          SELECT status AS label, count(*)::int AS value
          FROM appointments
          WHERE organization_id = $1 AND ($2::uuid IS NULL OR clinic_id = $2)
            AND (starts_at AT TIME ZONE 'Asia/Muscat')::date >= (now() AT TIME ZONE 'Asia/Muscat')::date - 13
          GROUP BY status
       ) st) AS status_mix,
       (SELECT COALESCE(json_agg(c ORDER BY c.amount DESC), '[]'::json) FROM (
          SELECT category AS label, count(*)::int AS count, COALESCE(SUM(total), 0)::float AS amount
          FROM invoices
          WHERE organization_id = $1 AND status <> 'void'
          GROUP BY category
       ) c) AS categories`,
    [org, clinic || null]
  );
  const row = rows[0];
  res.json({
    patients: row.patients,
    appointmentsToday: row.appointments_today,
    revenueToday: row.revenue_today,
    outstanding: row.outstanding,
    doctors: row.doctors,
    labOrders: row.lab_orders,
    labReported: row.lab_reported,
    pharmacySales: row.pharmacy_sales,
    lowStock: row.low_stock,
    newPatients: row.new_patients,
    followUps: row.follow_ups,
    noShows: row.no_shows,
    inQueue: row.in_queue,
    openInvoices: row.open_invoices,
    claimsPending: row.claims_pending,
    bedsOccupied: row.beds_occupied,
    bedsReady: row.beds_ready,
    schedule: row.schedule,
    expiring: row.expiring,
    trend: row.trend,
    hours: row.hours,
    statusMix: row.status_mix,
    categories: row.categories
  });
}));

router.get('/platform/overview', requirePermission('platform.health'), asyncRoute(async (req, res) => {
  const [tenants, users, patients, revenue, usage, storage, health, activity] = await Promise.all([
    adminQuery(`SELECT o.id, o.name, o.slug, o.status, o.city, o.primary_color, o.created_at,
                       s.status AS subscription_status, s.trial_ends_at, s.current_period_end, p.name AS plan_name,
                       (SELECT count(*)::int FROM clinics c WHERE c.organization_id = o.id) AS clinics,
                       (SELECT count(*)::int FROM users u WHERE u.organization_id = o.id) AS users,
                       (SELECT count(*)::int FROM patients pt WHERE pt.organization_id = o.id) AS patients
                FROM organizations o
                LEFT JOIN subscriptions s ON s.organization_id = o.id
                LEFT JOIN subscription_plans p ON p.id = s.plan_id
                ORDER BY o.created_at DESC`),
    adminQuery(`SELECT count(*)::int AS n FROM users`),
    adminQuery(`SELECT count(*)::int AS n FROM patients`),
    adminQuery(`SELECT COALESCE(SUM(amount), 0)::float AS n FROM saas_invoices WHERE status = 'paid'`),
    adminQuery(`SELECT count(*)::int AS n FROM activity_logs WHERE created_at > now() - interval '1 day'`),
    adminQuery(`SELECT pg_database_size(current_database())::bigint AS bytes`),
    adminQuery(`SELECT now() AS database_time, current_setting('server_version') AS version`),
    adminQuery(`SELECT COALESCE(json_agg(w ORDER BY w.day), '[]'::json) AS days FROM (
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
        (SELECT count(*)::int FROM activity_logs a WHERE (a.created_at AT TIME ZONE 'Asia/Muscat')::date = d::date) AS events
      FROM generate_series((now() AT TIME ZONE 'Asia/Muscat')::date - 13, (now() AT TIME ZONE 'Asia/Muscat')::date, interval '1 day') d
    ) w`)
  ]);
  res.json({
    tenants: tenants.rows,
    totalUsers: users.rows[0].n,
    totalPatients: patients.rows[0].n,
    subscriptionRevenue: revenue.rows[0].n,
    apiCallsToday: usage.rows[0].n,
    storageBytes: Number(storage.rows[0].bytes),
    health: health.rows[0],
    activity: activity.rows[0].days
  });
}));

router.patch('/platform/tenants/:id', requirePermission('platform.tenants'), asyncRoute(async (req, res) => {
  const status = req.body?.status;
  if (!['trial', 'active', 'suspended', 'inactive'].includes(status)) throw new HttpError(400, 'Unknown tenant status.');
  const { rows } = await adminQuery(
    `UPDATE organizations SET status = $2 WHERE id = $1 RETURNING id, name, status`,
    [req.params.id, status]
  );
  if (!rows[0]) throw new HttpError(404, 'Tenant not found.');
  if (status === 'suspended') {
    await adminQuery(`UPDATE subscriptions SET status = 'suspended' WHERE organization_id = $1`, [req.params.id]);
  }
  if (status === 'active') {
    await adminQuery(`UPDATE subscriptions SET status = 'active' WHERE organization_id = $1 AND status IN ('suspended', 'trialing')`, [req.params.id]);
  }
  await adminQuery(
    `INSERT INTO activity_logs (organization_id, user_id, action, entity, entity_id, ip)
     VALUES ($1, $2, 'tenant.status', 'organizations', $1, $3)`,
    [req.params.id, req.user.id, req.ip]
  );
  res.json({ tenant: rows[0] });
}));

router.get('/plans', asyncRoute(async (_req, res) => {
  const { rows } = await adminQuery(`SELECT * FROM subscription_plans WHERE is_public = true ORDER BY price_monthly`);
  res.json({ plans: rows });
}));

router.post('/subscription', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const org = req.user.organizationId;
  if (!org) throw new HttpError(403, 'Platform accounts do not have a clinic subscription.');
  const cycle = req.body?.billingCycle === 'yearly' ? 'yearly' : 'monthly';
  const saved = await tx(req, async (client) => {
    const plan = await client.query(`SELECT * FROM subscription_plans WHERE key = $1`, [req.body?.planKey]);
    if (!plan.rowCount) throw new HttpError(404, 'Plan not found.');
    const period = new Date();
    period.setDate(period.getDate() + (cycle === 'yearly' ? 365 : 30));
    const sub = await client.query(
      `UPDATE subscriptions SET plan_id = $2, status = 'active', billing_cycle = $3, current_period_end = $4
       WHERE organization_id = $1 RETURNING *`,
      [org, plan.rows[0].id, cycle, period]
    );
    await client.query(`UPDATE organizations SET status = 'active' WHERE id = $1`, [org]);
    const amount = cycle === 'yearly' ? plan.rows[0].price_yearly : plan.rows[0].price_monthly;
    const number = `SAAS-${Date.now().toString().slice(-8)}`;
    await client.query(
      `INSERT INTO saas_invoices (organization_id, subscription_id, number, amount, status, due_on, paid_on)
       VALUES ($1, $2, $3, $4, 'paid', CURRENT_DATE, CURRENT_DATE)`,
      [org, sub.rows[0].id, number, amount]
    );
    await audit(client, req, 'subscription.changed', 'subscriptions', sub.rows[0].id, { plan: plan.rows[0].key, cycle });
    return { subscription: sub.rows[0], plan: plan.rows[0], invoice: number };
  });
  res.json(saved);
}));

router.patch('/organization', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const org = req.user.organizationId;
  const body = req.body || {};
  const { rows } = await q(
    req,
    `UPDATE organizations
     SET name = COALESCE($2, name), legal_name = COALESCE($3, legal_name), logo_url = COALESCE($4, logo_url),
         primary_color = COALESCE($5, primary_color), accent_color = COALESCE($6, accent_color),
         email = COALESCE($7, email), phone = COALESCE($8, phone), address = COALESCE($9, address),
         city = COALESCE($10, city), country = COALESCE($11, country), website = COALESCE($12, website),
         settings = settings || COALESCE($13::jsonb, '{}'::jsonb)
     WHERE id = $1 RETURNING *`,
    [org, body.name || null, body.legalName || null, body.logoUrl || null, body.primaryColor || null, body.accentColor || null, body.email || null, body.phone || null, body.address || null, body.city || null, body.country || null, body.website || null, JSON.stringify(body.settings || {})]
  );
  res.json({ organization: rows[0] });
}));

router.get('/facilities', requirePermission('clinics.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const [clinics, departments, rooms, wards, beds, services, prices, hours, holidays] = await Promise.all([
    q(req, `SELECT * FROM clinics WHERE organization_id = $1 ORDER BY is_primary DESC, name`, [org]),
    q(req, `SELECT d.*, c.name AS clinic_name FROM departments d JOIN clinics c ON c.id = d.clinic_id WHERE d.organization_id = $1`, [org]),
    q(req, `SELECT * FROM rooms WHERE organization_id = $1 ORDER BY name`, [org]),
    q(req, `SELECT * FROM wards WHERE organization_id = $1 ORDER BY name`, [org]),
    q(req, `SELECT b.*, w.name AS ward_name FROM beds b JOIN wards w ON w.id = b.ward_id WHERE b.organization_id = $1`, [org]),
    q(req, `SELECT * FROM services WHERE organization_id = $1 ORDER BY name`, [org]),
    q(req, `SELECT * FROM service_prices WHERE organization_id = $1`, [org]),
    q(req, `SELECT * FROM working_hours WHERE organization_id = $1 ORDER BY weekday`, [org]),
    q(req, `SELECT * FROM holidays WHERE organization_id = $1 ORDER BY holiday_on`, [org])
  ]);
  res.json({
    clinics: clinics.rows,
    departments: departments.rows,
    rooms: rooms.rows,
    wards: wards.rows,
    beds: beds.rows,
    services: services.rows,
    prices: prices.rows,
    hours: hours.rows,
    holidays: holidays.rows
  });
}));

router.post('/clinics', requirePermission('clinics.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (!req.body?.name || !req.body?.code) throw new HttpError(400, 'Branch name and code are required.');
  const clinic = await tx(req, async (client) => {
    await guardSubscription(client, org, 'branches');
    const created = await client.query(
      `INSERT INTO clinics (organization_id, name, code, phone, email, address, city, timezone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [org, req.body.name, String(req.body.code).toUpperCase(), req.body.phone || null, req.body.email || null, req.body.address || null, req.body.city || null, req.body.timezone || 'Asia/Muscat']
    );
    await audit(client, req, 'clinic.created', 'clinics', created.rows[0].id);
    return created.rows[0];
  });
  res.status(201).json({ clinic });
}));

router.post('/departments', requirePermission('clinics.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  assertClinic(req, req.body?.clinicId);
  const { rows } = await q(
    req,
    `INSERT INTO departments (organization_id, clinic_id, name, code) VALUES ($1,$2,$3,$4) RETURNING *`,
    [org, req.body.clinicId, req.body.name, req.body.code || req.body.name.slice(0, 4).toUpperCase()]
  );
  res.status(201).json({ department: rows[0] });
}));

router.post('/rooms', requirePermission('clinics.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  assertClinic(req, req.body?.clinicId);
  assertDepartment(req, req.body?.departmentId);
  const type = req.body?.roomType === 'operation' ? 'operation' : 'consultation';
  const { rows } = await q(
    req,
    `INSERT INTO rooms (organization_id, clinic_id, department_id, name, room_type) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [org, req.body.clinicId, req.body.departmentId || null, req.body.name, type]
  );
  res.status(201).json({ room: rows[0] });
}));

router.post('/wards', requirePermission('clinics.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  assertClinic(req, req.body?.clinicId);
  const ward = await tx(req, async (client) => {
    const created = await client.query(
      `INSERT INTO wards (organization_id, clinic_id, name, ward_type) VALUES ($1,$2,$3,$4) RETURNING *`,
      [org, req.body.clinicId, req.body.name, req.body.wardType || 'general']
    );
    const count = Math.min(Number(req.body?.beds || 0), 30);
    for (let index = 1; index <= count; index += 1) {
      await client.query(
        `INSERT INTO beds (organization_id, clinic_id, ward_id, label) VALUES ($1,$2,$3,$4)`,
        [org, req.body.clinicId, created.rows[0].id, `${req.body.name.slice(0, 1).toUpperCase()}${index}`]
      );
    }
    return created.rows[0];
  });
  res.status(201).json({ ward });
}));

router.post('/services', requirePermission('clinics.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const { rows } = await q(
    req,
    `INSERT INTO services (organization_id, name, category, base_price, duration_minutes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [org, req.body.name, req.body.category || 'procedure', Number(req.body.price || 0), Number(req.body.durationMinutes || 20)]
  );
  res.status(201).json({ service: rows[0] });
}));

router.post('/service-prices', requirePermission('clinics.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  assertClinic(req, req.body?.clinicId);
  const { rows } = await q(
    req,
    `INSERT INTO service_prices (organization_id, service_id, clinic_id, price)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (service_id, clinic_id) DO UPDATE SET price = EXCLUDED.price
     RETURNING *`,
    [org, req.body.serviceId, req.body.clinicId, Number(req.body.price)]
  );
  res.status(201).json({ price: rows[0] });
}));

router.post('/holidays', requirePermission('clinics.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const { rows } = await q(
    req,
    `INSERT INTO holidays (organization_id, clinic_id, name, holiday_on) VALUES ($1,$2,$3,$4) RETURNING *`,
    [org, req.body.clinicId || null, req.body.name, req.body.holidayOn]
  );
  res.status(201).json({ holiday: rows[0] });
}));

router.get('/staff', requirePermission('appointments.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const { rows } = await q(
    req,
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.clinic_id, r.key AS role_key, r.name AS role_name,
            sp.designation, sp.specialization, sp.qualifications, sp.license_number, sp.license_expires_on,
            sp.consultation_fee, sp.commission_percent, sp.bio
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN staff_profiles sp ON sp.user_id = u.id
     WHERE u.organization_id = $1 AND r.key IN ('doctor', 'nurse', 'receptionist', 'pharmacist', 'lab_technician', 'accountant', 'hr_admin', 'clinic_admin', 'org_admin')
     ORDER BY u.full_name`,
    [org]
  );
  const schedules = await q(req, `SELECT * FROM doctor_schedules WHERE organization_id = $1 ORDER BY weekday, start_time`, [org]);
  const leaves = await q(
    req,
    `SELECT l.*, u.full_name FROM doctor_leaves l JOIN users u ON u.id = l.user_id WHERE l.organization_id = $1 ORDER BY l.starts_on DESC`,
    [org]
  );
  res.json({ staff: rows, schedules: schedules.rows, leaves: leaves.rows });
}));

router.post('/staff/:id/profile', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const { rows } = await q(
    req,
    `INSERT INTO staff_profiles (user_id, organization_id, designation, specialization, qualifications, license_number, license_expires_on, consultation_fee, commission_percent, bio)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id) DO UPDATE SET
       designation = EXCLUDED.designation, specialization = EXCLUDED.specialization, qualifications = EXCLUDED.qualifications,
       license_number = EXCLUDED.license_number, license_expires_on = EXCLUDED.license_expires_on,
       consultation_fee = EXCLUDED.consultation_fee, commission_percent = EXCLUDED.commission_percent, bio = EXCLUDED.bio
     RETURNING *`,
    [req.params.id, org, req.body.designation || null, req.body.specialization || null, req.body.qualifications || null, req.body.licenseNumber || null, req.body.licenseExpiresOn || null, Number(req.body.consultationFee || 0), Number(req.body.commissionPercent || 0), req.body.bio || null]
  );
  res.json({ profile: rows[0] });
}));

router.post('/staff/:id/schedules', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  assertClinic(req, req.body?.clinicId);
  const { rows } = await q(
    req,
    `INSERT INTO doctor_schedules (organization_id, user_id, clinic_id, weekday, start_time, end_time, slot_minutes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [org, req.params.id, req.body.clinicId, Number(req.body.weekday), req.body.startTime, req.body.endTime, Number(req.body.slotMinutes || 20)]
  );
  res.status(201).json({ schedule: rows[0] });
}));

router.post('/staff/:id/leave', requirePermission('hr.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const { rows } = await q(
    req,
    `INSERT INTO doctor_leaves (organization_id, user_id, starts_on, ends_on, reason, status)
     VALUES ($1,$2,$3,$4,$5,'approved') RETURNING *`,
    [org, req.params.id, req.body.startsOn, req.body.endsOn, req.body.reason || null]
  );
  res.status(201).json({ leave: rows[0] });
}));

router.get('/users', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const users = await q(
    req,
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.mfa_enabled, u.last_login_at, u.clinic_id,
            r.id AS role_id, r.key AS role_key, r.name AS role_name
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.organization_id = $1 ORDER BY u.full_name`,
    [org]
  );
  const roles = await q(
    req,
    `SELECT r.*, COALESCE(json_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '[]') AS permissions
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     WHERE r.organization_id IS NULL OR r.organization_id = $1
     GROUP BY r.id ORDER BY r.is_system DESC, r.name`,
    [org]
  );
  res.json({ users: users.rows, roles: roles.rows, catalog: PERMISSIONS.map(([key, module, description]) => ({ key, module, description })) });
}));

router.post('/users', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const fullName = String(req.body?.fullName || '').trim();
  if (!email || !fullName || !req.body?.roleId) throw new HttpError(400, 'Name, email, and role are required.');
  assertPasswordPolicy(req.body?.password || '');
  assertClinic(req, req.body?.clinicId);
  const user = await tx(req, async (client) => {
    await guardSubscription(client, org, 'users');
    const role = await client.query(
      `SELECT id, key FROM roles WHERE id = $1 AND (organization_id IS NULL OR organization_id = $2)`,
      [req.body.roleId, org]
    );
    if (!role.rowCount || role.rows[0].key === 'super_admin') throw new HttpError(400, 'Choose a valid role.');
    const passwordHash = await hashPassword(req.body.password);
    const created = await client.query(
      `INSERT INTO users (organization_id, clinic_id, role_id, email, password_hash, full_name, phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, full_name, email`,
      [org, req.body.clinicId || null, req.body.roleId, email, passwordHash, fullName, req.body.phone || null]
    );
    if (req.body.clinicId) {
      await client.query(
        `INSERT INTO user_clinics (user_id, clinic_id, organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [created.rows[0].id, req.body.clinicId, org]
      );
    }
    if (req.body.departmentId) {
      assertDepartment(req, req.body.departmentId);
      await client.query(
        `INSERT INTO user_departments (user_id, department_id, organization_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [created.rows[0].id, req.body.departmentId, org]
      );
    }
    await audit(client, req, 'user.created', 'users', created.rows[0].id);
    return created.rows[0];
  });
  res.status(201).json({ user });
}));

router.patch('/users/:id', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (req.body?.status && !['active', 'disabled'].includes(req.body.status)) throw new HttpError(400, 'Unknown account status.');
  const { rows } = await q(
    req,
    `UPDATE users SET status = COALESCE($3, status), role_id = COALESCE($4, role_id), clinic_id = COALESCE($5, clinic_id)
     WHERE organization_id = $1 AND id = $2 RETURNING id, full_name, status`,
    [org, req.params.id, req.body?.status || null, req.body?.roleId || null, req.body?.clinicId || null]
  );
  if (!rows[0]) throw new HttpError(404, 'User not found.');
  if (req.body?.status === 'disabled') {
    await adminQuery(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [req.params.id]);
  }
  res.json({ user: rows[0] });
}));

router.post('/roles', requirePermission('users.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const name = String(req.body?.name || '').trim();
  const keys = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  if (name.length < 2) throw new HttpError(400, 'Role name is required.');
  const known = new Set(PERMISSIONS.map(([key]) => key));
  const role = await tx(req, async (client) => {
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const created = await client.query(
      `INSERT INTO roles (organization_id, key, name, description, is_system) VALUES ($1,$2,$3,$4,false) RETURNING *`,
      [org, key, name, req.body.description || 'Custom role']
    );
    for (const permission of keys) {
      if (!known.has(permission) || permission.startsWith('platform.')) continue;
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_key, organization_id) VALUES ($1,$2,$3)`,
        [created.rows[0].id, permission, org]
      );
    }
    await audit(client, req, 'role.created', 'roles', created.rows[0].id);
    return created.rows[0];
  });
  res.status(201).json({ role });
}));

router.get('/notifications', requirePermission('notifications.read'), asyncRoute(async (req, res) => {
  const org = req.user.organizationId;
  if (!org) return res.json({ notifications: [] });
  const { rows } = await q(
    req,
    `SELECT * FROM notifications
     WHERE organization_id = $1 AND (user_id IS NULL OR user_id = $2 OR ($3::uuid IS NOT NULL AND patient_id = $3) OR $4::boolean)
     ORDER BY created_at DESC LIMIT 80`,
    [org, req.user.id, req.user.patientId, req.user.allClinics]
  );
  res.json({ notifications: rows });
}));

router.post('/notifications/read', requirePermission('notifications.read'), asyncRoute(async (req, res) => {
  await q(
    req,
    `UPDATE notifications SET read_at = now(), status = 'read'
     WHERE organization_id = $1 AND channel = 'in_app' AND read_at IS NULL
       AND (user_id = $2 OR ($3::uuid IS NOT NULL AND patient_id = $3))`,
    [req.user.organizationId, req.user.id, req.user.patientId]
  );
  res.json({ ok: true });
}));

router.get('/audit', requirePermission('audit.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const activity = await q(
    req,
    `SELECT a.*, u.full_name FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.organization_id = $1 ORDER BY a.created_at DESC LIMIT 100`,
    [org]
  );
  const logins = await q(
    req,
    `SELECT * FROM login_history WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [org]
  );
  const sessions = await q(
    req,
    `SELECT s.id, s.ip, s.user_agent, s.created_at, s.expires_at, s.revoked_at, u.full_name, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.organization_id = $1 ORDER BY s.created_at DESC LIMIT 40`,
    [org]
  );
  res.json({ activity: activity.rows, logins: logins.rows, sessions: sessions.rows });
}));

router.delete('/sessions/:id', requirePermission('audit.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  await q(req, `UPDATE sessions SET revoked_at = now() WHERE organization_id = $1 AND id = $2`, [org, req.params.id]);
  res.json({ ok: true });
}));

router.get('/backup', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const dump = { version: 1, exportedAt: new Date().toISOString(), organizationId: org, tables: {} };
  const organization = await q(req, `SELECT * FROM organizations WHERE id = $1`, [org]);
  if (!organization.rowCount) throw new HttpError(404, 'Organization not found.');
  dump.organization = organization.rows[0];
  for (const table of BACKUP_TABLES) {
    const rows = await q(req, `SELECT * FROM ${table} WHERE organization_id = $1`, [org]);
    dump.tables[table] = rows.rows;
  }
  res.json(dump);
}));

router.post('/restore', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  if (req.body?.confirm !== 'RESTORE') throw new HttpError(400, 'Type RESTORE to confirm replacement of tenant data.');
  const dump = req.body?.dump;
  const org = requireOrg(req);
  if (!dump?.tables || dump.organizationId !== org) throw new HttpError(400, 'Backup does not match this organization.');
  await tx(req, async (client) => {
    for (const table of [...BACKUP_TABLES].reverse()) {
      if (!Object.hasOwn(dump.tables, table)) continue;
      await client.query(`DELETE FROM ${table} WHERE organization_id = $1`, [org]);
    }
    if (dump.organization) {
      await client.query(
        `UPDATE organizations SET name = $2, legal_name = $3, logo_url = $4, primary_color = $5, accent_color = $6,
         email = $7, phone = $8, address = $9, city = $10, country = $11, settings = $12
         WHERE id = $1`,
        [org, dump.organization.name, dump.organization.legal_name, dump.organization.logo_url, dump.organization.primary_color, dump.organization.accent_color, dump.organization.email, dump.organization.phone, dump.organization.address, dump.organization.city, dump.organization.country, dump.organization.settings || {}]
      );
    }
    for (const table of BACKUP_TABLES) {
      const rows = dump.tables[table] || [];
      if (!rows.length) continue;
      const meta = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'atrium' AND table_name = $1`,
        [table]
      );
      const allowed = new Set(meta.rows.map((column) => column.column_name));
      for (const row of rows) {
        const columns = Object.keys(row).filter((column) => allowed.has(column) && /^[a-z_]+$/.test(column));
        if (!columns.length) continue;
        const values = columns.map((column) => row[column]);
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
        await client.query(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values
        );
      }
    }
    await audit(client, req, 'tenant.restored', 'organizations', org);
  });
  res.json({ ok: true });
}));

router.get('/integrations', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const integrations = await q(req, `SELECT id, provider, category, enabled, config FROM integrations WHERE organization_id = $1`, [org]);
  const webhooks = await q(req, `SELECT id, url, event, enabled FROM webhooks WHERE organization_id = $1`, [org]);
  res.json({ integrations: integrations.rows, webhooks: webhooks.rows, roleNames: ROLE_NAMES });
}));

router.post('/webhooks', requirePermission('settings.manage'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (!req.body?.url || !req.body?.event) throw new HttpError(400, 'Webhook URL and event are required.');
  const { rows } = await q(
    req,
    `INSERT INTO webhooks (organization_id, url, event, secret) VALUES ($1,$2,$3,$4) RETURNING id, url, event, enabled`,
    [org, req.body.url, req.body.event, req.body.secret || null]
  );
  res.status(201).json({ webhook: rows[0] });
}));

export default router;
