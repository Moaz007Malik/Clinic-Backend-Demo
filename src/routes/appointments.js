import { Router } from 'express';
import { q, tx } from '../db.js';
import { asyncRoute, HttpError } from '../http.js';
import { requireAuth, requirePermission } from '../auth.js';
import { assertClinic, audit, clinicClause, notify, patientClause, requireOrg } from '../scope.js';

const router = Router();
router.use(requireAuth);

const STATUSES = ['scheduled', 'confirmed', 'checked_in', 'in_consult', 'completed', 'cancelled', 'no_show'];

router.get('/', requirePermission('appointments.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org];
  let dateSql = '';
  if (req.query.date) {
    params.push(req.query.date);
    dateSql = ` AND (a.starts_at AT TIME ZONE 'Asia/Karachi')::date = $${params.length}::date`;
  }
  if (req.query.doctorId) {
    params.push(req.query.doctorId);
    dateSql += ` AND a.doctor_id = $${params.length}`;
  }
  if (req.query.status) {
    params.push(req.query.status);
    dateSql += ` AND a.status = $${params.length}`;
  }
  const clinic = clinicClause(req, 'a.clinic_id', params);
  const own = patientClause(req, 'a.patient_id', params);
  const { rows } = await q(
    req,
    `SELECT a.*, p.first_name, p.last_name, p.mrn, p.phone AS patient_phone,
            u.full_name AS doctor_name, c.name AS clinic_name
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     LEFT JOIN users u ON u.id = a.doctor_id
     LEFT JOIN clinics c ON c.id = a.clinic_id
     WHERE a.organization_id = $1 ${dateSql} ${clinic} ${own}
     ORDER BY a.starts_at`,
    params
  );
  res.json({ appointments: rows });
}));

router.get('/queue', requirePermission('appointments.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org];
  const clinic = clinicClause(req, 'a.clinic_id', params);
  const { rows } = await q(
    req,
    `SELECT a.id, a.token_number, a.queue_status, a.status, a.starts_at, a.visit_type,
            p.first_name, p.last_name, u.full_name AS doctor_name
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     LEFT JOIN users u ON u.id = a.doctor_id
     WHERE a.organization_id = $1
       AND (a.starts_at AT TIME ZONE 'Asia/Karachi')::date = (now() AT TIME ZONE 'Asia/Karachi')::date
       AND a.status IN ('checked_in', 'in_consult', 'confirmed', 'scheduled')
       ${clinic}
     ORDER BY a.token_number NULLS LAST, a.starts_at`,
    params
  );
  res.json({ queue: rows });
}));

router.get('/waiting-list', requirePermission('appointments.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org];
  const clinic = clinicClause(req, 'w.clinic_id', params);
  const own = patientClause(req, 'w.patient_id', params);
  const { rows } = await q(
    req,
    `SELECT w.*, p.first_name, p.last_name, p.mrn, u.full_name AS doctor_name
     FROM waiting_list w
     JOIN patients p ON p.id = w.patient_id
     LEFT JOIN users u ON u.id = w.doctor_id
     WHERE w.organization_id = $1 AND w.status = 'waiting' ${clinic} ${own}
     ORDER BY w.created_at`,
    params
  );
  res.json({ waiting: rows });
}));

router.post('/', requirePermission('appointments.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const body = req.body || {};
  if (!body.patientId || !body.startsAt) throw new HttpError(400, 'Patient and start time are required.');
  const clinicId = body.clinicId || req.clinicId;
  if (!clinicId) throw new HttpError(400, 'Choose a branch.');
  assertClinic(req, clinicId);
  if (req.user.roleKey === 'patient' && body.patientId !== req.user.patientId) {
    throw new HttpError(403, 'You can only book for your own chart.');
  }
  const visitType = ['in_person', 'walk_in', 'telemedicine'].includes(body.visitType) ? body.visitType : 'in_person';
  const duration = Number(body.durationMinutes || 20);
  const repeat = Math.min(Math.max(Number(body.repeatCount || 1), 1), 12);
  const created = await tx(req, async (client) => {
    const patient = await client.query(`SELECT id, first_name, portal_user_id FROM patients WHERE id = $1 AND organization_id = $2`, [body.patientId, org]);
    if (!patient.rowCount) throw new HttpError(404, 'Patient not found.');
    const seriesId = repeat > 1 ? crypto.randomUUID() : null;
    const rows = [];
    for (let index = 0; index < repeat; index += 1) {
      const start = new Date(body.startsAt);
      if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Start time is invalid.');
      start.setDate(start.getDate() + index * (body.repeatEvery === 'day' ? 1 : 7));
      const end = new Date(start.getTime() + duration * 60000);
      const inserted = await client.query(
        `INSERT INTO appointments (
           organization_id, clinic_id, patient_id, doctor_id, room_id, starts_at, ends_at,
           visit_type, status, reason, notes, queue_status, series_id, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          org,
          clinicId,
          body.patientId,
          body.doctorId || null,
          body.roomId || null,
          start,
          end,
          visitType,
          visitType === 'walk_in' ? 'checked_in' : 'scheduled',
          body.reason || null,
          body.notes || null,
          visitType === 'walk_in' ? 'waiting' : 'booked',
          seriesId,
          req.user.id
        ]
      );
      const appointment = inserted.rows[0];
      if (visitType === 'telemedicine') {
        const roomUrl = `https://meet.jit.si/Linden${appointment.id.replace(/-/g, '')}`;
        const updated = await client.query(`UPDATE appointments SET room_url = $1 WHERE id = $2 RETURNING *`, [roomUrl, appointment.id]);
        rows.push(updated.rows[0]);
      } else if (visitType === 'walk_in') {
        const token = await client.query(
          `SELECT COALESCE(MAX(token_number), 0) + 1 AS n FROM appointments
           WHERE organization_id = $1 AND clinic_id = $2
             AND (starts_at AT TIME ZONE 'Asia/Karachi')::date = (now() AT TIME ZONE 'Asia/Karachi')::date`,
          [org, clinicId]
        );
        const updated = await client.query(
          `UPDATE appointments SET token_number = $1 WHERE id = $2 RETURNING *`,
          [token.rows[0].n, appointment.id]
        );
        rows.push(updated.rows[0]);
      } else {
        rows.push(appointment);
      }
    }
    await notify(client, {
      organizationId: org,
      userId: patient.rows[0].portal_user_id,
      patientId: body.patientId,
      title: 'Appointment booked',
      body: `${patient.rows[0].first_name} has an appointment on ${new Date(body.startsAt).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })}.`,
      triggerKey: 'appointment.booked',
      channels: ['in_app', 'email', 'sms', 'whatsapp']
    });
    await audit(client, req, 'appointment.booked', 'appointments', rows[0].id, { repeat });
    return rows;
  });
  res.status(201).json({ appointments: created });
}));

router.post('/waiting-list', requirePermission('appointments.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const clinicId = req.body?.clinicId || req.clinicId;
  if (!req.body?.patientId || !clinicId) throw new HttpError(400, 'Patient and branch are required.');
  assertClinic(req, clinicId);
  const { rows } = await q(
    req,
    `INSERT INTO waiting_list (organization_id, clinic_id, patient_id, doctor_id, preferred_on, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [org, clinicId, req.body.patientId, req.body.doctorId || null, req.body.preferredOn || null, req.body.notes || null]
  );
  res.status(201).json({ item: rows[0] });
}));

router.patch('/:id', requirePermission('appointments.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const body = req.body || {};
  const current = await q(req, `SELECT * FROM appointments WHERE organization_id = $1 AND id = $2`, [org, req.params.id]);
  if (!current.rowCount) throw new HttpError(404, 'Appointment not found.');
  if (req.user.roleKey === 'patient' && current.rows[0].patient_id !== req.user.patientId) {
    throw new HttpError(403, 'That appointment belongs to another patient.');
  }
  const appointment = current.rows[0];
  const updated = await tx(req, async (client) => {
    let token = appointment.token_number;
    let queue = body.queueStatus || appointment.queue_status;
    const status = body.status || appointment.status;
    if (status && !STATUSES.includes(status)) throw new HttpError(400, 'Unknown appointment status.');
    if (status === 'checked_in' && !token) {
      const next = await client.query(
        `SELECT COALESCE(MAX(token_number), 0) + 1 AS n FROM appointments
         WHERE organization_id = $1 AND clinic_id = $2
           AND (starts_at AT TIME ZONE 'Asia/Karachi')::date = (now() AT TIME ZONE 'Asia/Karachi')::date`,
        [org, appointment.clinic_id]
      );
      token = next.rows[0].n;
      queue = 'waiting';
    }
    if (status === 'in_consult') queue = 'called';
    if (status === 'completed' || status === 'cancelled' || status === 'no_show') queue = 'done';
    const starts = body.startsAt ? new Date(body.startsAt) : appointment.starts_at;
    const ends = body.startsAt ? new Date(new Date(body.startsAt).getTime() + 20 * 60000) : appointment.ends_at;
    const saved = await client.query(
      `UPDATE appointments
       SET status = $3, starts_at = $4, ends_at = $5, doctor_id = COALESCE($6, doctor_id),
           reason = COALESCE($7, reason), notes = COALESCE($8, notes), token_number = $9, queue_status = $10
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [org, req.params.id, status, starts, ends, body.doctorId || null, body.reason || null, body.notes || null, token, queue]
    );
    if (['cancelled', 'no_show'].includes(status) || body.startsAt) {
      await notify(client, {
        organizationId: org,
        patientId: appointment.patient_id,
        title: status === 'cancelled' ? 'Appointment cancelled' : body.startsAt ? 'Appointment rescheduled' : 'Appointment update',
        body: status === 'no_show' ? 'A visit was marked as a no-show.' : 'Your appointment was updated.',
        triggerKey: `appointment.${status}`,
        channels: ['in_app', 'sms', 'email']
      });
    }
    await audit(client, req, 'appointment.updated', 'appointments', req.params.id, { status });
    return saved.rows[0];
  });
  res.json({ appointment: updated });
}));

export default router;
