import { Router } from 'express';
import { q, tx } from '../db.js';
import { asyncRoute, HttpError } from '../http.js';
import { requireAuth, requirePermission } from '../auth.js';
import { assertClinic, audit, clinicClause, notify, patientClause, requireOrg } from '../scope.js';

const router = Router();
router.use(requireAuth);

router.get('/encounters', requirePermission('emr.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org];
  let extra = '';
  if (req.query.patientId) {
    params.push(req.query.patientId);
    extra += ` AND e.patient_id = $${params.length}`;
  }
  extra += patientClause(req, 'e.patient_id', params);
  const { rows } = await q(
    req,
    `SELECT e.*, p.first_name, p.last_name, p.mrn, u.full_name AS doctor_name
     FROM encounters e
     JOIN patients p ON p.id = e.patient_id
     LEFT JOIN users u ON u.id = e.doctor_id
     WHERE e.organization_id = $1 ${extra}
     ORDER BY e.created_at DESC LIMIT 80`,
    params
  );
  res.json({ encounters: rows });
}));

router.post('/encounters', requirePermission('emr.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const body = req.body || {};
  if (!body.patientId) throw new HttpError(400, 'Choose a patient.');
  const clinicId = body.clinicId || req.clinicId;
  assertClinic(req, clinicId);
  const saved = await tx(req, async (client) => {
    const encounter = await client.query(
      `INSERT INTO encounters (
         organization_id, clinic_id, patient_id, doctor_id, appointment_id,
         subjective, objective, assessment, plan, symptoms, diagnosis, follow_up_on
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        org, clinicId || null, body.patientId, body.doctorId || req.user.id, body.appointmentId || null,
        body.subjective || null, body.objective || null, body.assessment || null, body.plan || null,
        body.symptoms || null, body.diagnosis || null, body.followUpOn || null
      ]
    );
    const vitals = body.vitals || {};
    if (Object.values(vitals).some((value) => value !== '' && value != null)) {
      await client.query(
        `INSERT INTO vitals (
           organization_id, encounter_id, patient_id, systolic, diastolic, pulse, temperature_c,
           spo2, respiratory_rate, weight_kg, height_cm
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          org, encounter.rows[0].id, body.patientId,
          num(vitals.systolic), num(vitals.diastolic), num(vitals.pulse), num(vitals.temperature),
          num(vitals.spo2), num(vitals.respiratoryRate), num(vitals.weight), num(vitals.height)
        ]
      );
    }
    if (body.appointmentId) {
      await client.query(
        `UPDATE appointments SET status = 'completed', queue_status = 'done'
         WHERE id = $1 AND organization_id = $2`,
        [body.appointmentId, org]
      );
    }
    if (body.referralTo) {
      await client.query(
        `INSERT INTO referrals (organization_id, encounter_id, patient_id, referred_to, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [org, encounter.rows[0].id, body.patientId, body.referralTo, body.referralReason || null]
      );
    }
    if (body.certificate) {
      await client.query(
        `INSERT INTO medical_certificates (organization_id, encounter_id, patient_id, summary)
         VALUES ($1, $2, $3, $4)`,
        [org, encounter.rows[0].id, body.patientId, body.certificate]
      );
    }
    await audit(client, req, 'encounter.created', 'encounters', encounter.rows[0].id);
    return encounter.rows[0];
  });
  res.status(201).json({ encounter: saved });
}));

router.get('/prescriptions', requirePermission('prescriptions.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org];
  let extra = patientClause(req, 'pr.patient_id', params);
  if (req.query.patientId) {
    params.push(req.query.patientId);
    extra += ` AND pr.patient_id = $${params.length}`;
  }
  const { rows } = await q(
    req,
    `SELECT pr.*, p.first_name, p.last_name, p.mrn, u.full_name AS doctor_name,
            COALESCE(json_agg(json_build_object(
              'id', pi.id, 'medicineName', pi.medicine_name, 'genericName', pi.generic_name,
              'dosage', pi.dosage, 'frequency', pi.frequency, 'duration', pi.duration, 'instructions', pi.instructions
            )) FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
     FROM prescriptions pr
     JOIN patients p ON p.id = pr.patient_id
     LEFT JOIN users u ON u.id = pr.doctor_id
     LEFT JOIN prescription_items pi ON pi.prescription_id = pr.id
     WHERE pr.organization_id = $1 ${extra}
     GROUP BY pr.id, p.id, u.id
     ORDER BY pr.created_at DESC LIMIT 80`,
    params
  );
  res.json({ prescriptions: rows });
}));

router.post('/prescriptions', requirePermission('prescriptions.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const items = Array.isArray(req.body?.items) ? req.body.items.filter((item) => item.medicineName) : [];
  if (!req.body?.patientId || !items.length) throw new HttpError(400, 'A patient and at least one medicine are required.');
  const saved = await tx(req, async (client) => {
    const prescription = await client.query(
      `INSERT INTO prescriptions (organization_id, encounter_id, patient_id, doctor_id, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [org, req.body.encounterId || null, req.body.patientId, req.user.id, req.body.notes || null]
    );
    for (const item of items) {
      await client.query(
        `INSERT INTO prescription_items (organization_id, prescription_id, medicine_name, generic_name, dosage, frequency, duration, instructions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [org, prescription.rows[0].id, item.medicineName, item.genericName || null, item.dosage || null, item.frequency || null, item.duration || null, item.instructions || null]
      );
    }
    await notify(client, {
      organizationId: org,
      patientId: req.body.patientId,
      title: 'New prescription',
      body: `${items.length} medicine${items.length === 1 ? '' : 's'} prescribed.`,
      triggerKey: 'prescription.created',
      channels: ['in_app', 'sms', 'email']
    });
    await audit(client, req, 'prescription.created', 'prescriptions', prescription.rows[0].id);
    return prescription.rows[0];
  });
  res.status(201).json({ prescription: saved });
}));

router.get('/lab/tests', requirePermission('lab.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const { rows } = await q(req, `SELECT * FROM lab_tests WHERE organization_id = $1 AND active = true ORDER BY name`, [org]);
  res.json({ tests: rows });
}));

router.post('/lab/tests', requirePermission('lab.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (!req.body?.name || !req.body?.code) throw new HttpError(400, 'Test name and code are required.');
  const { rows } = await q(
    req,
    `INSERT INTO lab_tests (organization_id, code, name, sample_type, price, unit, ref_low, ref_high, ref_text, turnaround_hours)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [org, req.body.code, req.body.name, req.body.sampleType || null, Number(req.body.price || 0), req.body.unit || null, num(req.body.refLow), num(req.body.refHigh), req.body.refText || null, Number(req.body.turnaroundHours || 24)]
  );
  res.status(201).json({ test: rows[0] });
}));

router.get('/lab/orders', requirePermission('lab.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org];
  const own = patientClause(req, 'o.patient_id', params);
  const clinic = clinicClause(req, 'o.clinic_id', params);
  const { rows } = await q(
    req,
    `SELECT o.*, p.first_name, p.last_name, p.mrn, u.full_name AS doctor_name,
            COALESCE(json_agg(json_build_object(
              'id', i.id, 'testId', i.lab_test_id, 'name', t.name, 'code', t.code, 'status', i.status,
              'resultValue', i.result_value, 'resultUnit', i.result_unit, 'flag', i.flag, 'remarks', i.remarks,
              'refLow', t.ref_low, 'refHigh', t.ref_high, 'refText', t.ref_text, 'unit', t.unit
            )) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
     FROM lab_orders o
     JOIN patients p ON p.id = o.patient_id
     LEFT JOIN users u ON u.id = o.doctor_id
     LEFT JOIN lab_order_items i ON i.lab_order_id = o.id
     LEFT JOIN lab_tests t ON t.id = i.lab_test_id
     WHERE o.organization_id = $1 ${own} ${clinic}
     GROUP BY o.id, p.id, u.id
     ORDER BY o.ordered_at DESC LIMIT 80`,
    params
  );
  res.json({ orders: rows });
}));

router.post('/lab/orders', requirePermission('lab.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const testIds = Array.isArray(req.body?.testIds) ? req.body.testIds : [];
  if (!req.body?.patientId || !testIds.length) throw new HttpError(400, 'Choose a patient and at least one test.');
  const clinicId = req.body.clinicId || req.clinicId;
  assertClinic(req, clinicId);
  const order = await tx(req, async (client) => {
    const created = await client.query(
      `INSERT INTO lab_orders (organization_id, clinic_id, patient_id, doctor_id, encounter_id, priority, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [org, clinicId || null, req.body.patientId, req.body.doctorId || req.user.id, req.body.encounterId || null, req.body.priority === 'urgent' ? 'urgent' : 'routine', req.body.notes || null]
    );
    for (const testId of testIds) {
      await client.query(
        `INSERT INTO lab_order_items (organization_id, lab_order_id, lab_test_id) VALUES ($1, $2, $3)`,
        [org, created.rows[0].id, testId]
      );
    }
    await audit(client, req, 'lab.ordered', 'lab_orders', created.rows[0].id);
    return created.rows[0];
  });
  res.status(201).json({ order });
}));

router.post('/lab/orders/:id/results', requirePermission('lab.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const approve = Boolean(req.body?.approve);
  await tx(req, async (client) => {
    for (const item of items) {
      const value = item.resultValue == null ? null : String(item.resultValue);
      let flag = null;
      if (value && item.refLow != null && item.refHigh != null && !Number.isNaN(Number(value))) {
        const numeric = Number(value);
        flag = numeric < Number(item.refLow) ? 'low' : numeric > Number(item.refHigh) ? 'high' : 'normal';
      }
      await client.query(
        `UPDATE lab_order_items
         SET result_value = $3, result_unit = COALESCE($4, result_unit), flag = $5, remarks = $6,
             status = $7, entered_by = $8, approved_by = $9, resulted_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [org, item.id, value, item.resultUnit || null, flag, item.remarks || null, approve ? 'approved' : 'resulted', req.user.id, approve ? req.user.id : null]
      );
    }
    const pending = await client.query(
      `SELECT count(*)::int AS n FROM lab_order_items WHERE lab_order_id = $1 AND organization_id = $2 AND result_value IS NULL`,
      [req.params.id, org]
    );
    const status = pending.rows[0].n === 0 ? (approve ? 'approved' : 'resulted') : 'collected';
    const order = await client.query(
      `UPDATE lab_orders SET status = $3 WHERE id = $1 AND organization_id = $2 RETURNING patient_id`,
      [req.params.id, org, status]
    );
    if (!order.rowCount) throw new HttpError(404, 'Lab order not found.');
    if (pending.rows[0].n === 0) {
      await notify(client, {
        organizationId: org,
        patientId: order.rows[0].patient_id,
        title: 'Lab results ready',
        body: approve ? 'A clinician approved your laboratory report.' : 'Laboratory results have been entered.',
        triggerKey: 'lab.resulted',
        channels: ['in_app', 'sms', 'email']
      });
    }
    await audit(client, req, 'lab.resulted', 'lab_orders', req.params.id);
  });
  res.json({ ok: true });
}));

router.get('/imaging', requirePermission('imaging.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org];
  const own = patientClause(req, 'o.patient_id', params);
  const { rows } = await q(
    req,
    `SELECT o.*, p.first_name, p.last_name, p.mrn, d.full_name AS doctor_name
     FROM imaging_orders o
     JOIN patients p ON p.id = o.patient_id
     LEFT JOIN users d ON d.id = o.doctor_id
     WHERE o.organization_id = $1 ${own}
     ORDER BY o.ordered_at DESC LIMIT 80`,
    params
  );
  res.json({ orders: rows });
}));

router.post('/imaging', requirePermission('imaging.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const modalities = ['xray', 'ultrasound', 'ct', 'mri', 'other'];
  if (!req.body?.patientId || !req.body?.studyName) throw new HttpError(400, 'Patient and study name are required.');
  const modality = modalities.includes(req.body.modality) ? req.body.modality : 'other';
  const clinicId = req.body.clinicId || req.clinicId;
  assertClinic(req, clinicId);
  const { rows } = await q(
    req,
    `INSERT INTO imaging_orders (organization_id, clinic_id, patient_id, doctor_id, modality, study_name, clinical_info, attachment_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [org, clinicId || null, req.body.patientId, req.body.doctorId || req.user.id, modality, req.body.studyName, req.body.clinicalInfo || null, req.body.attachmentUrl || null]
  );
  res.status(201).json({ order: rows[0] });
}));

router.patch('/imaging/:id', requirePermission('imaging.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const status = ['ordered', 'acquired', 'reported', 'approved', 'cancelled'].includes(req.body?.status) ? req.body.status : 'reported';
  const { rows } = await q(
    req,
    `UPDATE imaging_orders
     SET report = COALESCE($3, report), status = $4, attachment_url = COALESCE($5, attachment_url),
         radiologist_id = $6, reported_at = CASE WHEN $4 IN ('reported', 'approved') THEN now() ELSE reported_at END
     WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [org, req.params.id, req.body?.report || null, status, req.body?.attachmentUrl || null, req.user.id]
  );
  if (!rows[0]) throw new HttpError(404, 'Imaging order not found.');
  if (status === 'approved') {
    await tx(req, async (client) => {
      await notify(client, {
        organizationId: org,
        patientId: rows[0].patient_id,
        title: 'Imaging report ready',
        body: `${rows[0].study_name} has an approved report.`,
        triggerKey: 'imaging.approved',
        channels: ['in_app', 'email']
      });
    });
  }
  res.json({ order: rows[0] });
}));

router.get('/telemed/:appointmentId', requirePermission('telemed.join'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org, req.params.appointmentId];
  const own = patientClause(req, 'a.patient_id', params);
  const { rows } = await q(
    req,
    `SELECT a.*, p.first_name, p.last_name, u.full_name AS doctor_name
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     LEFT JOIN users u ON u.id = a.doctor_id
     WHERE a.organization_id = $1 AND a.id = $2 ${own}`,
    params
  );
  if (!rows[0]) throw new HttpError(404, 'Visit not found.');
  const messages = await q(
    req,
    `SELECT m.*, u.full_name AS sender_name FROM consult_messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.organization_id = $1 AND m.appointment_id = $2
     ORDER BY m.created_at`,
    [org, req.params.appointmentId]
  );
  res.json({ appointment: rows[0], messages: messages.rows });
}));

router.post('/telemed/:appointmentId/messages', requirePermission('telemed.join'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const body = String(req.body?.body || '').trim();
  if (!body) throw new HttpError(400, 'Message is empty.');
  const { rows } = await q(
    req,
    `INSERT INTO consult_messages (organization_id, appointment_id, sender_id, body)
     SELECT $1, a.id, $3, $4 FROM appointments a
     WHERE a.organization_id = $1 AND a.id = $2
       AND ($5::uuid IS NULL OR a.patient_id = $5)
     RETURNING *`,
    [org, req.params.appointmentId, req.user.id, body, req.user.roleKey === 'patient' ? req.user.patientId : null]
  );
  if (!rows[0]) throw new HttpError(404, 'Visit not found.');
  res.status(201).json({ message: rows[0] });
}));

router.get('/ai/brief/:patientId', requirePermission('ai.use'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org, req.params.patientId];
  const own = patientClause(req, 'id', params);
  const patient = await q(req, `SELECT * FROM patients WHERE organization_id = $1 AND id = $2 ${own}`, params);
  if (!patient.rowCount) throw new HttpError(404, 'Patient not found.');
  const [allergies, conditions, vitals, appointments, labs] = await Promise.all([
    q(req, `SELECT * FROM allergies WHERE organization_id = $1 AND patient_id = $2`, [org, req.params.patientId]),
    q(req, `SELECT * FROM conditions WHERE organization_id = $1 AND patient_id = $2`, [org, req.params.patientId]),
    q(req, `SELECT * FROM vitals WHERE organization_id = $1 AND patient_id = $2 ORDER BY recorded_at DESC LIMIT 1`, [org, req.params.patientId]),
    q(req, `SELECT status FROM appointments WHERE organization_id = $1 AND patient_id = $2`, [org, req.params.patientId]),
    q(req, `SELECT flag FROM lab_order_items WHERE organization_id = $1 AND lab_order_id IN (SELECT id FROM lab_orders WHERE patient_id = $2)`, [org, req.params.patientId])
  ]);
  const person = patient.rows[0];
  const noShows = appointments.rows.filter((row) => row.status === 'no_show').length;
  const visits = appointments.rows.length;
  const risk = visits >= 2 && noShows / visits >= 0.25 ? 'high' : noShows > 0 ? 'moderate' : 'low';
  const severe = allergies.rows.filter((row) => row.severity === 'severe');
  const latest = vitals.rows[0];
  const alerts = [];
  if (severe.length) alerts.push(`Severe allergy: ${severe.map((row) => row.substance).join(', ')}.`);
  if (latest?.systolic >= 140 || latest?.diastolic >= 90) alerts.push(`Last blood pressure was ${latest.systolic}/${latest.diastolic}.`);
  if (latest?.spo2 != null && latest.spo2 < 94) alerts.push(`Last oxygen saturation was ${latest.spo2}%.`);
  const abnormal = labs.rows.filter((row) => row.flag && row.flag !== 'normal').length;
  if (abnormal) alerts.push(`${abnormal} laboratory result${abnormal === 1 ? '' : 's'} outside the reference range.`);
  const summary = [
    `${person.first_name} ${person.last_name} (${person.mrn})`,
    conditions.rows.length ? `Active history includes ${conditions.rows.map((row) => row.name).join(', ')}.` : 'No prior diagnoses are recorded.',
    allergies.rows.length ? `Allergies: ${allergies.rows.map((row) => row.substance).join(', ')}.` : 'No allergies recorded.',
    `No-show heuristic is ${risk} (${noShows} of ${visits} visits).`
  ].join(' ');
  res.json({
    summary,
    alerts,
    noShowRisk: risk,
    source: 'chart-heuristic',
    disclaimer: 'This brief is generated from the chart. It is not a diagnosis.'
  });
}));

router.get('/ai/forecasts', requirePermission('ai.use'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const { rows } = await q(
    req,
    `SELECT m.name, m.reorder_level, COALESCE(SUM(b.quantity), 0)::int AS on_hand,
            COALESCE((
              SELECT SUM(ABS(sm.quantity)) FROM stock_movements sm
              WHERE sm.medicine_id = m.id AND sm.movement_type = 'sale'
                AND sm.created_at > now() - interval '30 days'
            ), 0)::int AS sold_30d
     FROM medicines m
     LEFT JOIN stock_batches b ON b.medicine_id = m.id
     WHERE m.organization_id = $1
     GROUP BY m.id
     ORDER BY on_hand ASC
     LIMIT 12`,
    [org]
  );
  const forecasts = rows.map((row) => {
    const daily = row.sold_30d / 30;
    const days = daily > 0 ? Math.round(row.on_hand / daily) : null;
    return { ...row, dailyUse: Number(daily.toFixed(2)), daysOfCover: days, reorder: row.on_hand <= row.reorder_level };
  });
  res.json({ forecasts, disclaimer: 'Forecast uses the last 30 days of dispenses. Sparse history means a rough estimate.' });
}));

function num(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default router;
