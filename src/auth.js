import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as OTPAuth from 'otpauth';
import { adminQuery } from './db.js';
import { HttpError } from './http.js';

const SESSION_HOURS = 8;

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function buildTotp(email, secret) {
  return new OTPAuth.TOTP({
    issuer: 'Linden',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret)
  });
}

export function newMfaSecret() {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export async function openSession(user, req) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
  await adminQuery(
    `INSERT INTO sessions (organization_id, user_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user.organization_id, user.id, hashToken(token), req.ip, req.get('user-agent') || '', expires]
  );
  await adminQuery(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  await adminQuery(
    `INSERT INTO login_history (organization_id, user_id, email, ip, user_agent, success)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [user.organization_id, user.id, user.email, req.ip, req.get('user-agent') || '']
  );
  return { token, expiresAt: expires.toISOString() };
}

export async function recordFailure(req, email, reason, user) {
  await adminQuery(
    `INSERT INTO login_history (organization_id, user_id, email, ip, user_agent, success, failure_reason)
     VALUES ($1, $2, $3, $4, $5, false, $6)`,
    [user?.organization_id || null, user?.id || null, email, req.ip, req.get('user-agent') || '', reason]
  );
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new HttpError(401, 'Sign in required.');

    const { rows } = await adminQuery(
      `SELECT s.id AS session_id, s.expires_at, s.revoked_at,
              u.id, u.organization_id, u.clinic_id, u.patient_id, u.role_id, u.email, u.full_name,
              u.phone, u.status, u.mfa_enabled, r.key AS role_key, r.name AS role_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
       WHERE s.token_hash = $1`,
      [hashToken(token)]
    );
    const row = rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
      throw new HttpError(401, 'Session expired. Sign in again.');
    }
    if (row.status !== 'active') throw new HttpError(403, 'This account is disabled.');

    let organization = null;
    if (row.organization_id) {
      const org = await adminQuery(`SELECT * FROM organizations WHERE id = $1`, [row.organization_id]);
      organization = org.rows[0] || null;
      if (organization && ['suspended', 'inactive'].includes(organization.status)) {
        throw new HttpError(403, 'This organization is not active.');
      }
    }

    const perms = await adminQuery(`SELECT permission_key FROM role_permissions WHERE role_id = $1`, [row.role_id]);
    const clinics = await adminQuery(`SELECT clinic_id FROM user_clinics WHERE user_id = $1`, [row.id]);
    const departments = await adminQuery(`SELECT department_id FROM user_departments WHERE user_id = $1`, [row.id]);
    const clinicIds = clinics.rows.map((item) => item.clinic_id);
    if (row.clinic_id && !clinicIds.includes(row.clinic_id)) clinicIds.push(row.clinic_id);

    req.user = {
      id: row.id,
      organizationId: row.organization_id,
      clinicId: row.clinic_id,
      patientId: row.patient_id,
      roleId: row.role_id,
      roleKey: row.role_key,
      roleName: row.role_name,
      email: row.email,
      fullName: row.full_name,
      phone: row.phone,
      isSuper: row.role_key === 'super_admin',
      permissions: row.role_key === 'super_admin' ? ['*'] : perms.rows.map((item) => item.permission_key),
      clinicIds,
      allClinics: ['super_admin', 'org_admin', 'clinic_admin'].includes(row.role_key),
      departmentIds: departments.rows.map((item) => item.department_id),
      sessionId: row.session_id,
      mfaEnabled: row.mfa_enabled
    };
    req.organization = organization;

    const headerClinic = req.get('x-clinic-id');
    if (headerClinic) {
      if (!req.user.isSuper && !req.user.allClinics && !req.user.clinicIds.includes(headerClinic)) {
        throw new HttpError(403, 'You do not have access to that branch.');
      }
      if (!req.user.isSuper && organization) {
        const owned = await adminQuery(
          `SELECT 1 FROM clinics WHERE id = $1 AND organization_id = $2`,
          [headerClinic, organization.id]
        );
        if (!owned.rowCount) throw new HttpError(403, 'That branch is outside this organization.');
      }
      req.clinicId = headerClinic;
    } else {
      req.clinicId = row.clinic_id;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requirePermission(...keys) {
  return (req, _res, next) => {
    if (req.user?.isSuper || req.user?.permissions.includes('*')) return next();
    const missing = keys.some((key) => !req.user?.permissions.includes(key));
    if (missing) return next(new HttpError(403, 'You do not have permission for this action.'));
    next();
  };
}

export function requireAny(...keys) {
  return (req, _res, next) => {
    if (req.user?.isSuper || req.user?.permissions.includes('*')) return next();
    const allowed = keys.some((key) => req.user?.permissions.includes(key));
    if (!allowed) return next(new HttpError(403, 'You do not have permission for this action.'));
    next();
  };
}
