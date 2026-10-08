import { Router } from 'express';
import { q, tx } from '../db.js';
import { asyncRoute, HttpError } from '../http.js';
import { requireAuth, requirePermission } from '../auth.js';
import { assertClinic, audit, clinicClause, guardSubscription, nextMrn, patientClause, requireOrg } from '../scope.js';

const router = Router();
router.use(requireAuth);

router.get('/', requirePermission('patients.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org];
  const term = String(req.query.q || '').trim();
  let search = '';
  if (term) {
    params.push(`%${term}%`);
    search = ` AND (p.first_name ILIKE $${params.length} OR p.last_name ILIKE $${params.length} OR p.mrn ILIKE $${params.length} OR COALESCE(p.phone, '') ILIKE $${params.length})`;
  }
  const clinic = clinicClause(req, 'p.clinic_id', params);
  const own = patientClause(req, 'p.id', params);
  const { rows } = await q(
    req,
    `SELECT p.*, c.name AS clinic_name
     FROM patients p
     LEFT JOIN clinics c ON c.id = p.clinic_id
     WHERE p.organization_id = $1 ${search} ${clinic} ${own}
     ORDER BY p.created_at DESC
     LIMIT 150`,
    params
  );
  res.json({ patients: rows });
}));

router.post('/', requirePermission('patients.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const body = req.body || {};
  const firstName = String(body.firstName || '').trim();
  const lastName = String(body.lastName || '').trim();
  if (!firstName || !lastName) throw new HttpError(400, 'First and last name are required.');
  assertClinic(req, body.clinicId);
  const patient = await tx(req, async (client) => {
    await guardSubscription(client, org, 'patients');
    const orgRow = await client.query(`SELECT slug FROM organizations WHERE id = $1`, [org]);
    const mrn = await nextMrn(client, org, orgRow.rows[0]?.slug);
    const inserted = await client.query(
      `INSERT INTO patients (
         organization_id, clinic_id, mrn, first_name, last_name, dob, sex, blood_group,
         phone, email, address, city, national_id, photo_url, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        org,
        body.clinicId || req.clinicId || null,
        mrn,
        firstName,
        lastName,
        body.dob || null,
        body.sex || null,
        body.bloodGroup || null,
        body.phone || null,
        body.email || null,
        body.address || null,
        body.city || null,
        body.nationalId || null,
        body.photoUrl && String(body.photoUrl).length < 250000 ? body.photoUrl : null,
        body.notes || null
      ]
    );
    if (body.emergencyName && body.emergencyPhone) {
      await client.query(
        `INSERT INTO emergency_contacts (organization_id, patient_id, name, relationship, phone)
         VALUES ($1, $2, $3, $4, $5)`,
        [org, inserted.rows[0].id, body.emergencyName, body.emergencyRelationship || null, body.emergencyPhone]
      );
    }
    await audit(client, req, 'patient.created', 'patients', inserted.rows[0].id, { mrn });
    return inserted.rows[0];
  });
  res.status(201).json({ patient });
}));

router.get('/:id', requirePermission('patients.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org, req.params.id];
  const own = patientClause(req, 'p.id', params);
  const { rows } = await q(
    req,
    `SELECT p.*, c.name AS clinic_name FROM patients p
     LEFT JOIN clinics c ON c.id = p.clinic_id
     WHERE p.organization_id = $1 AND p.id = $2 ${own}`,
    params
  );
  if (!rows[0]) throw new HttpError(404, 'Patient not found.');
  const id = rows[0].id;
  const [contacts, allergies, conditions, surgeries, family, documents, consents, policies] = await Promise.all([
    q(req, `SELECT * FROM emergency_contacts WHERE organization_id = $1 AND patient_id = $2`, [org, id]),
    q(req, `SELECT * FROM allergies WHERE organization_id = $1 AND patient_id = $2 ORDER BY noted_on DESC`, [org, id]),
    q(req, `SELECT * FROM conditions WHERE organization_id = $1 AND patient_id = $2 ORDER BY diagnosed_on DESC NULLS LAST`, [org, id]),
    q(req, `SELECT * FROM surgeries WHERE organization_id = $1 AND patient_id = $2 ORDER BY performed_on DESC NULLS LAST`, [org, id]),
    q(req, `SELECT * FROM family_histories WHERE organization_id = $1 AND patient_id = $2`, [org, id]),
    q(req, `SELECT * FROM patient_documents WHERE organization_id = $1 AND patient_id = $2 ORDER BY created_at DESC`, [org, id]),
    q(req, `SELECT * FROM consents WHERE organization_id = $1 AND patient_id = $2 ORDER BY recorded_at DESC`, [org, id]),
    q(req, `SELECT pp.*, ip.name AS plan_name, i.name AS insurer_name
            FROM patient_policies pp
            JOIN insurance_plans ip ON ip.id = pp.plan_id
            JOIN insurers i ON i.id = ip.insurer_id
            WHERE pp.organization_id = $1 AND pp.patient_id = $2`, [org, id])
  ]);
  res.json({
    patient: rows[0],
    contacts: contacts.rows,
    allergies: allergies.rows,
    conditions: conditions.rows,
    surgeries: surgeries.rows,
    family: family.rows,
    documents: documents.rows,
    consents: consents.rows,
    policies: policies.rows
  });
}));

router.get('/:id/timeline', requirePermission('patients.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org, req.params.id];
  const own = patientClause(req, 'p.id', params);
  const allowed = await q(req, `SELECT p.id FROM patients p WHERE p.organization_id = $1 AND p.id = $2 ${own}`, params);
  if (!allowed.rowCount) throw new HttpError(404, 'Patient not found.');
  const { rows } = await q(
    req,
    `SELECT * FROM (
       SELECT 'appointment' AS kind, a.id, a.starts_at AS at, a.status AS detail, COALESCE(a.reason, a.visit_type) AS title
       FROM appointments a WHERE a.organization_id = $1 AND a.patient_id = $2
       UNION ALL
       SELECT 'encounter', e.id, e.created_at, COALESCE(e.diagnosis, 'Consultation'), COALESCE(e.assessment, e.subjective, 'Clinical note')
       FROM encounters e WHERE e.organization_id = $1 AND e.patient_id = $2
       UNION ALL
       SELECT 'lab', l.id, l.ordered_at, l.status, 'Laboratory order'
       FROM lab_orders l WHERE l.organization_id = $1 AND l.patient_id = $2
       UNION ALL
       SELECT 'invoice', i.id, i.issued_at, i.status, i.number
       FROM invoices i WHERE i.organization_id = $1 AND i.patient_id = $2
     ) events
     ORDER BY at DESC
     LIMIT 80`,
    [org, req.params.id]
  );
  res.json({ events: rows });
}));

router.patch('/:id', requirePermission('patients.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const body = req.body || {};
  const fields = {
    first_name: body.firstName,
    last_name: body.lastName,
    dob: body.dob,
    sex: body.sex,
    blood_group: body.bloodGroup,
    phone: body.phone,
    email: body.email,
    address: body.address,
    city: body.city,
    national_id: body.nationalId,
    notes: body.notes,
    photo_url: body.photoUrl,
    clinic_id: body.clinicId
  };
  const sets = [];
  const params = [org, req.params.id];
  for (const [column, value] of Object.entries(fields)) {
    if (value !== undefined) {
      if (column === 'photo_url' && value && String(value).length > 250000) {
        throw new HttpError(400, 'Photograph is too large.');
      }
      params.push(value || null);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  if (body.clinicId) assertClinic(req, body.clinicId);
  const { rows } = await q(
    req,
    `UPDATE patients SET ${sets.join(', ')} WHERE organization_id = $1 AND id = $2 RETURNING *`,
    params
  );
  if (!rows[0]) throw new HttpError(404, 'Patient not found.');
  res.json({ patient: rows[0] });
}));

function chartRouter(table, columns) {
  router.post(`/:id/${table}`, requirePermission('patients.write'), asyncRoute(async (req, res) => {
    const org = requireOrg(req);
    const values = columns.map((column) => req.body?.[column] ?? null);
    if (columns.includes('name') && !req.body?.name && !req.body?.substance && !req.body?.procedure_name && !req.body?.condition && !req.body?.title && !req.body?.consent_type) {
      throw new HttpError(400, 'A name or description is required.');
    }
    const placeholders = columns.map((_, index) => `$${index + 3}`).join(', ');
    const { rows } = await q(
      req,
      `INSERT INTO ${table} (organization_id, patient_id, ${columns.join(', ')})
       VALUES ($1, $2, ${placeholders}) RETURNING *`,
      [org, req.params.id, ...values]
    );
    res.status(201).json({ item: rows[0] });
  }));
}

chartRouter('allergies', ['substance', 'reaction', 'severity']);
chartRouter('conditions', ['name', 'status', 'diagnosed_on', 'notes']);
chartRouter('surgeries', ['procedure_name', 'performed_on', 'facility', 'notes']);
chartRouter('family_histories', ['relation', 'condition', 'notes']);
chartRouter('emergency_contacts', ['name', 'relationship', 'phone']);
chartRouter('patient_documents', ['title', 'category', 'file_url']);
chartRouter('consents', ['consent_type', 'granted', 'notes']);

export default router;
