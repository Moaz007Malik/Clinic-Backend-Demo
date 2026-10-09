import { HttpError } from './http.js';

export function requireOrg(req) {
  if (req.user.isSuper) {
    const requested = req.user.organizationId || req.query.organizationId || req.body?.organizationId;
    if (!requested) throw new HttpError(400, 'Choose an organization first.');
    return requested;
  }
  if (!req.user.organizationId) throw new HttpError(403, 'No organization is assigned to this account.');
  return req.user.organizationId;
}

export function ownOrg(req) {
  if (!req.user.organizationId) throw new HttpError(403, 'No organization is assigned to this account.');
  return req.user.organizationId;
}

export function assertClinic(req, clinicId) {
  if (!clinicId || req.user.isSuper || req.user.allClinics) return;
  if (!req.user.clinicIds.includes(clinicId)) throw new HttpError(403, 'Branch access denied.');
}

export function assertDepartment(req, departmentId) {
  if (!departmentId || req.user.isSuper || !req.user.departmentIds.length) return;
  if (!req.user.departmentIds.includes(departmentId)) throw new HttpError(403, 'Department access denied.');
}

export function clinicClause(req, column, params) {
  if (req.user.roleKey === 'patient') return '';
  if (req.clinicId) {
    assertClinic(req, req.clinicId);
    params.push(req.clinicId);
    return ` AND ${column} = $${params.length}`;
  }
  if (!req.user.isSuper && !req.user.allClinics) {
    if (!req.user.clinicIds.length) return ' AND FALSE';
    params.push(req.user.clinicIds);
    return ` AND ${column} = ANY($${params.length}::uuid[])`;
  }
  return '';
}

export function patientClause(req, column, params) {
  if (req.user.roleKey !== 'patient') return '';
  if (!req.user.patientId) throw new HttpError(403, 'No patient chart is linked to this login.');
  params.push(req.user.patientId);
  return ` AND ${column} = $${params.length}`;
}

export async function guardSubscription(client, organizationId, resource) {
  const { rows } = await client.query(
    `SELECT s.status, s.trial_ends_at, s.current_period_end, p.name AS plan_name,
            p.max_users, p.max_patients, p.max_branches, p.sms_quota
     FROM subscriptions s
     JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.organization_id = $1`,
    [organizationId]
  );
  const sub = rows[0];
  if (!sub) throw new HttpError(402, 'This organization has no subscription.');
  const now = new Date();
  const trialOver = sub.status === 'trialing' && sub.trial_ends_at && new Date(sub.trial_ends_at) < now;
  const periodOver = sub.status === 'active' && sub.current_period_end && new Date(sub.current_period_end) < now;
  if (trialOver || periodOver) {
    await client.query(`UPDATE subscriptions SET status = 'suspended' WHERE organization_id = $1`, [organizationId]);
    await client.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [organizationId]);
    throw new HttpError(402, trialOver ? 'The free trial has ended and the organization is suspended.' : 'The subscription period ended and the organization is suspended.');
  }
  if (['suspended', 'canceled'].includes(sub.status)) {
    throw new HttpError(402, 'The subscription is suspended. Upgrade the plan to continue.');
  }
  const checks = {
    patients: ['patients', sub.max_patients, 'patients'],
    users: ['users', sub.max_users, 'users'],
    branches: ['clinics', sub.max_branches, 'branches']
  };
  const check = checks[resource];
  if (check && check[1] != null) {
    const count = await client.query(`SELECT count(*)::int AS n FROM ${check[0]} WHERE organization_id = $1`, [organizationId]);
    if (count.rows[0].n >= check[1]) {
      throw new HttpError(402, `${sub.plan_name} includes ${check[1]} ${check[2]}. Upgrade to add more.`);
    }
  }
}

export async function audit(client, req, action, entity, entityId, metadata = {}) {
  await client.query(
    `INSERT INTO activity_logs (organization_id, user_id, action, entity, entity_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [req.user?.organizationId || req.body?.organizationId || null, req.user?.id || null, action, entity, entityId || null, metadata, req.ip]
  );
}

export async function notify(client, payload) {
  const channels = payload.channels || ['in_app', 'email', 'sms'];
  for (const channel of channels) {
    await client.query(
      `INSERT INTO notifications (organization_id, user_id, patient_id, channel, title, body, status, trigger_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        payload.organizationId,
        payload.userId || null,
        payload.patientId || null,
        channel,
        payload.title,
        payload.body,
        channel === 'in_app' ? 'sent' : 'queued',
        payload.triggerKey || null
      ]
    );
  }
}

export async function nextMrn(client, organizationId, slug) {
  const result = await client.query(
    `INSERT INTO mrn_counters (organization_id, next_value)
     VALUES ($1, 1001)
     ON CONFLICT (organization_id)
     DO UPDATE SET next_value = mrn_counters.next_value + 1
     RETURNING next_value`,
    [organizationId]
  );
  const prefix = String(slug || 'mrn').replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'MRN';
  return `${prefix}-${result.rows[0].next_value}`;
}

export async function nextInvoiceNumber(client, organizationId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [`invoice:${organizationId}`]);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(CAST(NULLIF(regexp_replace(number, '\\D', '', 'g'), '') AS int)), 1000) + 1 AS n
     FROM invoices WHERE organization_id = $1`,
    [organizationId]
  );
  return `INV-${String(rows[0].n).padStart(5, '0')}`;
}
