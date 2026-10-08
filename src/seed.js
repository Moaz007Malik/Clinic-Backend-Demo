import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS, ROLE_GRANTS, ROLE_NAMES } from './catalog.js';
import { adminPool, adminQuery } from './db.js';
import { hashPassword } from './auth.js';
import { karachiStamp } from './http.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '../../database/schema.sql');

async function ensureRole() {
  const password = String(process.env.APP_ROLE_PASSWORD || '').replace(/'/g, "''");
  if (!password) return false;
  try {
    await adminQuery(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atrium_app') THEN
          EXECUTE format('CREATE ROLE atrium_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', '${password}');
        ELSE
          EXECUTE format('ALTER ROLE atrium_app WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', '${password}');
        END IF;
      END
      $$;
    `);
    return true;
  } catch (error) {
    console.warn(`Could not create the atrium_app database role (${error.message}).`);
    return false;
  }
}

async function applySchema(appRole) {
  let sql = fs.readFileSync(schemaPath, 'utf8');
  if (!appRole) sql = sql.split('\n').filter((line) => !line.includes('atrium_app')).join('\n');
  await adminQuery(sql);
}

async function upsertCatalog(client) {
  for (const [key, module, description] of PERMISSIONS) {
    await client.query(
      `INSERT INTO permissions (key, module, description) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description`,
      [key, module, description]
    );
  }
  const plans = [
    ['starter', 'Starter', 'A single clinic finding its rhythm.', 0, 0, 5, 300, 1, 2000, 100, 50, ['Patient registry', 'Appointments', 'Billing']],
    ['clinic', 'Clinic', 'For groups running a few branches.', 18000, 180000, 40, 8000, 3, 20000, 2000, 1000, ['EMR', 'Laboratory', 'Pharmacy', 'Insurance']],
    ['hospital', 'Hospital', 'Wards, imaging, and a larger staff.', 48000, 480000, 150, 40000, 10, 100000, 10000, 5000, ['Wards and beds', 'Radiology', 'HR', 'API access']],
    ['enterprise', 'Enterprise', 'Unlimited scale with dedicated controls.', 96000, 960000, null, null, null, null, null, null, ['Unlimited branches', 'PACS connector', 'Webhooks', 'Priority support']]
  ];
  for (const plan of plans) {
    const values = [...plan];
    values[11] = JSON.stringify(plan[11]);
    await client.query(
      `INSERT INTO subscription_plans (key, name, description, price_monthly, price_yearly, max_users, max_patients, max_branches, max_storage_mb, sms_quota, whatsapp_quota, features)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, price_monthly = EXCLUDED.price_monthly,
         price_yearly = EXCLUDED.price_yearly, max_users = EXCLUDED.max_users, max_patients = EXCLUDED.max_patients,
         max_branches = EXCLUDED.max_branches, features = EXCLUDED.features`,
      values
    );
  }
  for (const [key, name] of Object.entries(ROLE_NAMES)) {
    const existing = await client.query(`SELECT id FROM roles WHERE key = $1 AND organization_id IS NULL`, [key]);
    const roleId = existing.rowCount
      ? existing.rows[0].id
      : (await client.query(`INSERT INTO roles (key, name, is_system) VALUES ($1, $2, true) RETURNING id`, [key, name])).rows[0].id;
    for (const permission of ROLE_GRANTS[key]) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roleId, permission]
      );
    }
  }
}

function id() {
  return crypto.randomUUID();
}

async function seedDemo(client, passwordHash) {
  const existing = await client.query(`SELECT id FROM organizations WHERE slug = 'northwind'`);
  if (existing.rowCount && process.env.RESET_DEMO !== '1') {
    console.log('Demo clinics already exist. Set RESET_DEMO=1 to rebuild them.');
    return;
  }
  if (existing.rowCount) {
    await client.query(`DELETE FROM organizations WHERE slug IN ('northwind', 'lumen')`);
    await client.query(`DELETE FROM users WHERE email IN ('super@atrium.local', 'super@linden.local')`);
  }

  const roles = Object.fromEntries(
    (await client.query(`SELECT id, key FROM roles WHERE organization_id IS NULL`)).rows.map((row) => [row.key, row.id])
  );
  const plans = Object.fromEntries(
    (await client.query(`SELECT id, key FROM subscription_plans`)).rows.map((row) => [row.key, row.id])
  );

  const northwind = id();
  const lumen = id();
  const harbor = id();
  const ridge = id();
  const lumenClinic = id();
  const deptGm = id();
  const deptLab = id();

  await client.query(
    `INSERT INTO organizations (id, name, legal_name, slug, status, primary_color, accent_color, email, phone, address, city, country, timezone, settings)
     VALUES ($1, 'Northwind Health', 'Northwind Health (Pvt) Ltd', 'northwind', 'active', '#1c6b52', '#c56a32', 'hello@northwind.local', '+92 21 3522 0100', '12 Harbor Road', 'Karachi', 'Pakistan', 'Asia/Karachi', '{"sessionHours":8,"passwordMinLength":10}'::jsonb),
            ($2, 'Lumen Pediatrics', 'Lumen Pediatrics', 'lumen', 'trial', '#2457a6', '#e0a100', 'hello@lumen.local', '+92 42 111 2200', '8 Garden Lane', 'Lahore', 'Pakistan', 'Asia/Karachi', '{}'::jsonb)`,
    [northwind, lumen]
  );

  const trialEnd = new Date(Date.now() + 14 * 86400000);
  const periodEnd = new Date(Date.now() + 300 * 86400000);
  await client.query(
    `INSERT INTO subscriptions (organization_id, plan_id, status, billing_cycle, trial_ends_at, current_period_end)
     VALUES ($1, $2, 'active', 'yearly', NULL, $4), ($5, $6, 'trialing', 'monthly', $3, $3)`,
    [northwind, plans.clinic, trialEnd, periodEnd, lumen, plans.starter]
  );
  await client.query(
    `INSERT INTO saas_invoices (organization_id, number, amount, status, due_on, paid_on)
     VALUES ($1, 'SAAS-10021', 180000, 'paid', CURRENT_DATE - 20, CURRENT_DATE - 18)`,
    [northwind]
  );

  await client.query(
    `INSERT INTO clinics (id, organization_id, name, code, phone, email, address, city, timezone, is_primary)
     VALUES ($1,$2,'Harbor Clinic','HBR','+92 21 3522 0101','harbor@northwind.local','12 Harbor Road','Karachi','Asia/Karachi',true),
            ($3,$2,'Ridge Street Clinic','RDG','+92 21 3522 0188','ridge@northwind.local','44 Ridge Street','Karachi','Asia/Karachi',false),
            ($4,$5,'Lumen Gulberg','GUL','+92 42 111 2200','gulberg@lumen.local','8 Garden Lane','Lahore','Asia/Karachi',true)`,
    [harbor, northwind, ridge, lumenClinic, lumen]
  );

  await client.query(
    `INSERT INTO departments (id, organization_id, clinic_id, name, code) VALUES
     ($1,$2,$3,'General Medicine','GM'), ($4,$2,$3,'Laboratory','LAB'),
     ($5,$2,$6,'Radiology','RAD'), ($7,$2,$8,'Pediatrics','PED')`,
    [deptGm, northwind, harbor, deptLab, id(), ridge, id(), lumenClinic]
  );
  const consult = id();
  const ot = id();
  await client.query(
    `INSERT INTO rooms (id, organization_id, clinic_id, department_id, name, room_type) VALUES
     ($1,$2,$3,$4,'Consult 1','consultation'), ($5,$2,$3,$4,'Consult 2','consultation'),
     ($6,$2,$3,NULL,'OT 1','operation')`,
    [consult, northwind, harbor, deptGm, id(), ot]
  );
  const ward = id();
  await client.query(
    `INSERT INTO wards (id, organization_id, clinic_id, name, ward_type) VALUES ($1,$2,$3,'Day Ward','day')`,
    [ward, northwind, harbor]
  );
  await client.query(
    `INSERT INTO beds (organization_id, clinic_id, ward_id, label, status) VALUES
     ($1,$2,$3,'A1','occupied'), ($1,$2,$3,'A2','available'), ($1,$2,$3,'A3','maintenance')`,
    [northwind, harbor, ward]
  );

  const consultService = id();
  const followService = id();
  await client.query(
    `INSERT INTO services (id, organization_id, name, category, base_price, duration_minutes) VALUES
     ($1,$2,'General consultation','consultation',3500,20),
     ($3,$2,'Follow-up visit','consultation',2000,15),
     ($4,$2,'Wound dressing','procedure',1500,15)`,
    [consultService, northwind, followService, id()]
  );
  await client.query(
    `INSERT INTO service_prices (organization_id, service_id, clinic_id, price) VALUES ($1,$2,$3,4000)`,
    [northwind, consultService, ridge]
  );
  for (const clinicId of [harbor, ridge]) {
    for (let day = 0; day < 7; day += 1) {
      const closed = day === 0;
      await client.query(
        `INSERT INTO working_hours (organization_id, clinic_id, weekday, opens, closes, is_closed)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [northwind, clinicId, day, closed ? null : day === 6 ? '09:00' : '08:00', closed ? null : day === 6 ? '13:00' : '18:00', closed]
      );
    }
  }
  await client.query(
    `INSERT INTO holidays (organization_id, clinic_id, name, holiday_on) VALUES ($1, NULL, 'Founders Day', CURRENT_DATE + 21)`,
    [northwind]
  );

  const people = [
    ['super@linden.local', 'Sana Qureshi', 'super_admin', null, null],
    ['amira@northwind.local', 'Amira Shah', 'org_admin', northwind, harbor],
    ['leila@northwind.local', 'Leila Rahman', 'clinic_admin', northwind, harbor],
    ['dr.hassan@northwind.local', 'Dr. Hassan Ali', 'doctor', northwind, harbor],
    ['dr.okonkwo@northwind.local', 'Dr. Ada Okonkwo', 'doctor', northwind, ridge],
    ['nora@northwind.local', 'Nora Iqbal', 'nurse', northwind, harbor],
    ['rafi@northwind.local', 'Rafi Mensah', 'receptionist', northwind, harbor],
    ['samir@northwind.local', 'Samir Dar', 'pharmacist', northwind, harbor],
    ['lina@northwind.local', 'Lina Cho', 'lab_technician', northwind, harbor],
    ['omar@northwind.local', 'Omar Farid', 'accountant', northwind, harbor],
    ['hana@northwind.local', 'Hana Yusuf', 'hr_admin', northwind, harbor],
    ['maya@northwind.local', 'Maya Rahman', 'patient', northwind, harbor],
    ['nina@lumen.local', 'Nina Dar', 'org_admin', lumen, lumenClinic]
  ];
  const users = {};
  for (const [email, fullName, role, org, clinic] of people) {
    const userId = id();
    users[email] = userId;
    await client.query(
      `INSERT INTO users (id, organization_id, clinic_id, role_id, email, password_hash, full_name, phone, last_login_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - interval '2 hours')`,
      [userId, org, clinic, roles[role], email, passwordHash, fullName, role === 'patient' ? '+92 300 555 0142' : null]
    );
    if (clinic) {
      await client.query(`INSERT INTO user_clinics (user_id, clinic_id, organization_id) VALUES ($1,$2,$3)`, [userId, clinic, org]);
    }
  }
  await client.query(`INSERT INTO user_departments (user_id, department_id, organization_id) VALUES ($1,$2,$3)`, [users['nora@northwind.local'], deptGm, northwind]);
  await client.query(`INSERT INTO user_departments (user_id, department_id, organization_id) VALUES ($1,$2,$3)`, [users['lina@northwind.local'], deptLab, northwind]);

  await client.query(
    `INSERT INTO staff_profiles (user_id, organization_id, designation, specialization, qualifications, license_number, license_expires_on, consultation_fee, commission_percent, bio)
     VALUES
     ($1,$2,'Consultant Physician','Internal medicine','MBBS, FCPS','PMC-44821', CURRENT_DATE + 400, 3500, 15, 'Looks after long-term conditions and same-day sick visits.'),
     ($3,$2,'Consultant Pediatrician','Pediatrics','MBBS, MRCPCH','PMC-22910', CURRENT_DATE + 220, 4000, 12, 'Sees children at Ridge Street and on video.')`,
    [users['dr.hassan@northwind.local'], northwind, users['dr.okonkwo@northwind.local']]
  );
  for (const doctorId of [users['dr.hassan@northwind.local'], users['dr.okonkwo@northwind.local']]) {
    const clinicId = doctorId === users['dr.hassan@northwind.local'] ? harbor : ridge;
    for (let day = 1; day <= 5; day += 1) {
      await client.query(
        `INSERT INTO doctor_schedules (organization_id, user_id, clinic_id, weekday, start_time, end_time, slot_minutes)
         VALUES ($1,$2,$3,$4,'09:00','13:00',20)`,
        [northwind, doctorId, clinicId, day]
      );
    }
  }
  await client.query(
    `INSERT INTO doctor_leaves (organization_id, user_id, starts_on, ends_on, reason, status)
     VALUES ($1,$2, CURRENT_DATE + 10, CURRENT_DATE + 12, 'Conference', 'approved')`,
    [northwind, users['dr.okonkwo@northwind.local']]
  );

  const patients = [
    ['Maya Rahman', '1989-04-12', 'female', 'B+', '+92 300 555 0142', 'maya@northwind.local', 'Clifton', 'Hypertension and seasonal asthma.'],
    ['Yusuf Rahman', '2018-09-02', 'male', 'O+', '+92 300 555 0143', null, 'Clifton', "Maya's son. Peanut allergy."],
    ['Elena Petrova', '1976-11-30', 'female', 'A-', '+92 321 555 0190', 'elena@example.com', 'DHA', 'Telemedicine follow-up for migraine.'],
    ['James Okello', '1968-01-19', 'male', 'AB+', '+92 333 555 0111', null, 'PECHS', 'Missed last fasting glucose visit.'],
    ['Fatima Noor', '1994-06-08', 'female', 'O-', '+92 345 555 0177', null, 'Saddar', 'Antenatal bloods pending.'],
    ['Arjun Mehta', '1982-12-01', 'male', 'B-', '+92 300 555 0160', null, 'Bahadurabad', 'Type 2 diabetes, on metformin.'],
    ['Sofia Alvarez', '2001-03-22', 'female', 'A+', '+92 311 555 0133', null, 'North Nazimabad', 'Shoulder pain after a fall.'],
    ['Daniel Cho', '1959-08-14', 'male', 'O+', '+92 321 555 0188', null, 'Korangi', 'COPD, uses a reliever inhaler.']
  ];
  const patientIds = {};
  let mrn = 1001;
  for (const [name, dob, sex, blood, phone, email, city, notes] of patients) {
    const [first, ...rest] = name.split(' ');
    const patientId = id();
    patientIds[name] = patientId;
    await client.query(
      `INSERT INTO patients (id, organization_id, clinic_id, mrn, first_name, last_name, dob, sex, blood_group, phone, email, city, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [patientId, northwind, harbor, `NOR-${mrn}`, first, rest.join(' '), dob, sex, blood, phone, email, city, notes]
    );
    mrn += 1;
  }
  await client.query(`INSERT INTO mrn_counters (organization_id, next_value) VALUES ($1, $2)`, [northwind, mrn]);
  await client.query(`UPDATE users SET patient_id = $1 WHERE id = $2`, [patientIds['Maya Rahman'], users['maya@northwind.local']]);
  await client.query(`UPDATE patients SET portal_user_id = $1 WHERE id = $2`, [users['maya@northwind.local'], patientIds['Maya Rahman']]);

  const lumenPatient = id();
  await client.query(
    `INSERT INTO patients (id, organization_id, clinic_id, mrn, first_name, last_name, dob, sex, phone, city)
     VALUES ($1,$2,$3,'LUM-1001','Ayaan','Malik','2020-05-11','male','+92 42 555 0101','Lahore')`,
    [lumenPatient, lumen, lumenClinic]
  );
  await client.query(`INSERT INTO mrn_counters (organization_id, next_value) VALUES ($1, 1002)`, [lumen]);

  await client.query(
    `INSERT INTO emergency_contacts (organization_id, patient_id, name, relationship, phone) VALUES
     ($1,$2,'Imran Rahman','Spouse','+92 300 555 0101'),
     ($1,$3,'Sara Mehta','Spouse','+92 300 555 0108')`,
    [northwind, patientIds['Maya Rahman'], patientIds['Arjun Mehta']]
  );
  await client.query(
    `INSERT INTO allergies (organization_id, patient_id, substance, reaction, severity) VALUES
     ($1,$2,'Penicillin','Rash and wheeze','severe'),
     ($1,$3,'Peanuts','Swelling','severe'),
     ($1,$4,'Ibuprofen','Gastric upset','mild')`,
    [northwind, patientIds['Maya Rahman'], patientIds['Yusuf Rahman'], patientIds['Daniel Cho']]
  );
  await client.query(
    `INSERT INTO conditions (organization_id, patient_id, name, status, diagnosed_on) VALUES
     ($1,$2,'Hypertension','chronic','2019-03-01'),
     ($1,$2,'Asthma','active','2008-06-01'),
     ($1,$3,'Type 2 diabetes','chronic','2016-11-12'),
     ($1,$4,'Migraine','active','2021-02-02')`,
    [northwind, patientIds['Maya Rahman'], patientIds['Arjun Mehta'], patientIds['Elena Petrova']]
  );
  await client.query(
    `INSERT INTO surgeries (organization_id, patient_id, procedure_name, performed_on, facility) VALUES ($1,$2,'Appendicectomy','2004-08-19','Civil Hospital')`,
    [northwind, patientIds['James Okello']]
  );
  await client.query(
    `INSERT INTO family_histories (organization_id, patient_id, relation, condition) VALUES ($1,$2,'Mother','Type 2 diabetes')`,
    [northwind, patientIds['Arjun Mehta']]
  );
  await client.query(
    `INSERT INTO consents (organization_id, patient_id, consent_type, granted, recorded_by) VALUES
     ($1,$2,'Treatment',true,$3), ($1,$2,'Data sharing with insurer',true,$3), ($1,$4,'Telemedicine',true,$3)`,
    [northwind, patientIds['Maya Rahman'], users['rafi@northwind.local'], patientIds['Elena Petrova']]
  );
  await client.query(
    `INSERT INTO patient_documents (organization_id, patient_id, title, category, file_url, uploaded_by) VALUES
     ($1,$2,'National ID scan','identity',NULL,$3)`,
    [northwind, patientIds['Maya Rahman'], users['rafi@northwind.local']]
  );

  const hassan = users['dr.hassan@northwind.local'];
  const ada = users['dr.okonkwo@northwind.local'];
  const visits = [
    [patientIds['Maya Rahman'], hassan, karachiStamp(9, 0), 'confirmed', 'in_person', 'Blood pressure review', 12],
    [patientIds['Yusuf Rahman'], ada, karachiStamp(9, 40), 'checked_in', 'walk_in', 'Fever and cough', 4],
    [patientIds['Elena Petrova'], hassan, karachiStamp(11, 30), 'scheduled', 'telemedicine', 'Migraine follow-up', null],
    [patientIds['Fatima Noor'], hassan, karachiStamp(14, 0), 'scheduled', 'in_person', 'Antenatal visit', null],
    [patientIds['Arjun Mehta'], hassan, karachiStamp(15, 20), 'scheduled', 'in_person', 'Diabetes review', null],
    [patientIds['James Okello'], hassan, karachiStamp(10, 0, -1), 'no_show', 'in_person', 'Fasting glucose', null],
    [patientIds['Daniel Cho'], ada, karachiStamp(11, 0, -1), 'completed', 'in_person', 'Inhaler review', null],
    [patientIds['Sofia Alvarez'], ada, karachiStamp(16, 0), 'confirmed', 'in_person', 'Shoulder ultrasound request', null]
  ];
  const appointmentIds = {};
  for (const [patientId, doctorId, starts, status, type, reason, token] of visits) {
    const appointmentId = id();
    appointmentIds[patientId] = appointmentId;
    const roomUrl = type === 'telemedicine' ? `https://meet.jit.si/Linden${appointmentId.replace(/-/g, '')}` : null;
    await client.query(
      `INSERT INTO appointments (id, organization_id, clinic_id, patient_id, doctor_id, room_id, starts_at, ends_at, visit_type, status, reason, token_number, queue_status, room_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7::timestamptz + interval '20 minutes',$8,$9,$10,$11,$12,$13,$14)`,
      [appointmentId, northwind, doctorId === ada ? ridge : harbor, patientId, doctorId, doctorId === hassan ? consult : null, starts, type, status, reason, token, status === 'checked_in' ? 'waiting' : status === 'completed' ? 'done' : 'booked', roomUrl, users['rafi@northwind.local']]
    );
  }
  await client.query(
    `INSERT INTO waiting_list (organization_id, clinic_id, patient_id, doctor_id, preferred_on, notes)
     VALUES ($1,$2,$3,$4, CURRENT_DATE + 1, 'Prefers a morning slot after school.')`,
    [northwind, harbor, patientIds['Yusuf Rahman'], ada]
  );

  const encounterId = id();
  await client.query(
    `INSERT INTO encounters (id, organization_id, clinic_id, patient_id, doctor_id, appointment_id, subjective, objective, assessment, plan, symptoms, diagnosis, follow_up_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CURRENT_DATE + 14)`,
    [
      encounterId, northwind, ridge, patientIds['Daniel Cho'], ada, appointmentIds[patientIds['Daniel Cho']],
      'More short of breath when climbing stairs. Using the reliever twice a day.',
      'Speaking in full sentences. Mild wheeze on expiration.',
      'COPD with increased reliever use.',
      'Continue inhaler technique coaching. Review in two weeks. Safety-net for fever or chest pain.',
      'Dyspnea, wheeze',
      'COPD'
    ]
  );
  await client.query(
    `INSERT INTO vitals (organization_id, encounter_id, patient_id, systolic, diastolic, pulse, temperature_c, spo2, respiratory_rate, weight_kg, height_cm)
     VALUES
     ($1, NULL, $2, 148, 92, 88, 36.7, 95, 18, 64.2, 162),
     ($1, $3, $4, 128, 78, 84, 36.6, 96, 20, 71.4, 172)`,
    [northwind, patientIds['Maya Rahman'], encounterId, patientIds['Daniel Cho']]
  );
  await client.query(
    `INSERT INTO referrals (organization_id, encounter_id, patient_id, referred_to, reason) VALUES ($1,$2,$3,'Pulmonology','Persistent reliever use')`,
    [northwind, encounterId, patientIds['Daniel Cho']]
  );
  await client.query(
    `INSERT INTO medical_certificates (organization_id, encounter_id, patient_id, summary) VALUES ($1,$2,$3,'Fit for desk work. Avoid dust exposure this week.')`,
    [northwind, encounterId, patientIds['Daniel Cho']]
  );

  const rx = id();
  await client.query(
    `INSERT INTO prescriptions (id, organization_id, encounter_id, patient_id, doctor_id, notes) VALUES ($1,$2,$3,$4,$5,'Inhaler technique reviewed.')`,
    [rx, northwind, encounterId, patientIds['Daniel Cho'], ada]
  );
  await client.query(
    `INSERT INTO prescription_items (organization_id, prescription_id, medicine_name, generic_name, dosage, frequency, duration, instructions)
     VALUES ($1,$2,'Salbutamol inhaler','Salbutamol','100 mcg','2 puffs','14 days','Use through a spacer when wheezy.')`,
    [northwind, rx]
  );
  const rxMaya = id();
  await client.query(
    `INSERT INTO prescriptions (id, organization_id, patient_id, doctor_id, notes, status) VALUES ($1,$2,$3,$4,'Continue home BP log.','active')`,
    [rxMaya, northwind, patientIds['Maya Rahman'], hassan]
  );
  await client.query(
    `INSERT INTO prescription_items (organization_id, prescription_id, medicine_name, generic_name, dosage, frequency, duration, instructions)
     VALUES ($1,$2,'Amlodipine','Amlodipine','5 mg','Once daily','30 days','Do not take with grapefruit juice.')`,
    [northwind, rxMaya]
  );

  const meds = {
    Amoxicillin: id(),
    Paracetamol: id(),
    Amlodipine: id(),
    Metformin: id(),
    Salbutamol: id()
  };
  const medRows = [
    [meds.Amoxicillin, 'Amoxicillin', 'Amoxicillin', 'Amoxil', 'capsule', '500 mg', 40, 180],
    [meds.Paracetamol, 'Paracetamol', 'Paracetamol', 'Panadol', 'tablet', '500 mg', 50, 40],
    [meds.Amlodipine, 'Amlodipine', 'Amlodipine', 'Norvasc', 'tablet', '5 mg', 30, 25],
    [meds.Metformin, 'Metformin', 'Metformin', 'Glucophage', 'tablet', '500 mg', 30, 15],
    [meds.Salbutamol, 'Salbutamol inhaler', 'Salbutamol', 'Ventolin', 'inhaler', '100 mcg', 8, 650]
  ];
  for (const row of medRows) {
    await client.query(
      `INSERT INTO medicines (id, organization_id, name, generic_name, brand_name, form, strength, reorder_level, sell_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row[0], northwind, row[1], row[2], row[3], row[4], row[5], row[6], row[7]]
    );
  }
  const supplier = id();
  await client.query(
    `INSERT INTO suppliers (id, organization_id, name, phone, email, address) VALUES ($1,$2,'Creek Pharma','+92 21 3400 1000','orders@creek.example','SITE Karachi')`,
    [supplier, northwind]
  );
  const batches = [
    [meds.Amoxicillin, 'AMX-2401', 120, 90, 90],
    [meds.Paracetamol, 'PCM-1180', 30, 8, 40],
    [meds.Amlodipine, 'AML-090', 200, 400, 6],
    [meds.Metformin, 'MET-332', 80, 12, 60],
    [meds.Salbutamol, 'SAL-014', 6, 300, 4]
  ];
  for (const [medicineId, batchNo, days, qty, cost] of batches) {
    await client.query(
      `INSERT INTO stock_batches (organization_id, clinic_id, medicine_id, supplier_id, batch_no, expiry_on, quantity, cost_price)
       VALUES ($1,$2,$3,$4,$5, CURRENT_DATE + $6::int, $7, $8)`,
      [northwind, harbor, medicineId, supplier, batchNo, days, qty, cost]
    );
  }
  await client.query(
    `INSERT INTO stock_movements (organization_id, clinic_id, medicine_id, movement_type, quantity, reason, created_by)
     VALUES ($1,$2,$3,'sale',-12,'Counter sale',$4)`,
    [northwind, harbor, meds.Paracetamol, users['samir@northwind.local']]
  );
  const po = id();
  await client.query(
    `INSERT INTO purchase_orders (id, organization_id, clinic_id, supplier_id, status, notes) VALUES ($1,$2,$3,$4,'ordered','Restock inhalers')`,
    [po, northwind, harbor, supplier]
  );
  await client.query(
    `INSERT INTO purchase_order_items (organization_id, purchase_order_id, medicine_id, quantity, unit_cost) VALUES ($1,$2,$3,20,420)`,
    [northwind, po, meds.Salbutamol]
  );

  const cbc = id();
  const fbs = id();
  await client.query(
    `INSERT INTO lab_tests (id, organization_id, code, name, sample_type, price, unit, ref_low, ref_high, turnaround_hours) VALUES
     ($1,$2,'CBC','Complete blood count','Blood',1800,'g/dL',12,15.5,8),
     ($3,$2,'FBS','Fasting blood glucose','Blood',700,'mg/dL',70,99,6),
     ($4,$2,'HCG','Pregnancy test','Urine',900,NULL,NULL,NULL,2)`,
    [cbc, northwind, fbs, id()]
  );
  const labOrder = id();
  await client.query(
    `INSERT INTO lab_orders (id, organization_id, clinic_id, patient_id, doctor_id, status, priority) VALUES ($1,$2,$3,$4,$5,'resulted','routine')`,
    [labOrder, northwind, harbor, patientIds['Fatima Noor'], hassan]
  );
  await client.query(
    `INSERT INTO lab_order_items (organization_id, lab_order_id, lab_test_id, status, result_value, result_unit, flag, entered_by, resulted_at)
     VALUES ($1,$2,$3,'resulted','11.2','g/dL','low',$4, now() - interval '3 hours')`,
    [northwind, labOrder, cbc, users['lina@northwind.local']]
  );
  const pendingLab = id();
  await client.query(
    `INSERT INTO lab_orders (id, organization_id, clinic_id, patient_id, doctor_id, status, priority) VALUES ($1,$2,$3,$4,$5,'ordered','urgent')`,
    [pendingLab, northwind, harbor, patientIds['Arjun Mehta'], hassan]
  );
  await client.query(
    `INSERT INTO lab_order_items (organization_id, lab_order_id, lab_test_id, status) VALUES ($1,$2,$3,'pending')`,
    [northwind, pendingLab, fbs]
  );

  await client.query(
    `INSERT INTO imaging_orders (organization_id, clinic_id, patient_id, doctor_id, modality, study_name, status, clinical_info)
     VALUES ($1,$2,$3,$4,'ultrasound','Right shoulder ultrasound','ordered','Pain after a fall, limited abduction.')`,
    [northwind, ridge, patientIds['Sofia Alvarez'], ada]
  );
  await client.query(
    `INSERT INTO imaging_orders (organization_id, clinic_id, patient_id, doctor_id, radiologist_id, modality, study_name, status, report, reported_at)
     VALUES ($1,$2,$3,$4,$4,'xray','Chest X-ray','approved','No focal consolidation. Hyperinflation consistent with known COPD.', now() - interval '1 day')`,
    [northwind, ridge, patientIds['Daniel Cho'], ada]
  );

  const invoiceOpen = id();
  const invoicePaid = id();
  const invoicePartial = id();
  await client.query(
    `INSERT INTO invoices (id, organization_id, clinic_id, patient_id, doctor_id, number, category, status, subtotal, discount, tax, total, balance)
     VALUES
     ($1,$2,$3,$4,$5,'INV-01001','consultation','open',3500,0,0,3500,3500),
     ($6,$2,$3,$7,$5,'INV-01002','lab','paid',1800,0,0,1800,0),
     ($8,$2,$9,$10,$11,'INV-01003','consultation','partial',4000,500,0,3500,1500)`,
    [invoiceOpen, northwind, harbor, patientIds['Maya Rahman'], hassan, invoicePaid, patientIds['Fatima Noor'], invoicePartial, ridge, patientIds['Sofia Alvarez'], ada]
  );
  await client.query(
    `INSERT INTO invoice_lines (organization_id, invoice_id, description, quantity, unit_price, amount) VALUES
     ($1,$2,'General consultation',1,3500,3500),
     ($1,$3,'Complete blood count',1,1800,1800),
     ($1,$4,'Pediatric consultation',1,4000,4000)`,
    [northwind, invoiceOpen, invoicePaid, invoicePartial]
  );
  await client.query(
    `INSERT INTO payments (organization_id, invoice_id, amount, method, kind, received_by) VALUES
     ($1,$2,1800,'card','payment',$3),
     ($1,$4,2000,'cash','payment',$3)`,
    [northwind, invoicePaid, users['omar@northwind.local'], invoicePartial]
  );

  const insurer = id();
  const plan = id();
  const policy = id();
  await client.query(`INSERT INTO insurers (id, organization_id, name, phone, email) VALUES ($1,$2,'Seabreeze Assurance','+92 21 111 333 444','claims@seabreeze.example')`, [insurer, northwind]);
  await client.query(`INSERT INTO insurance_plans (id, organization_id, insurer_id, name, coverage_percent) VALUES ($1,$2,$3,'Family Plus',80)`, [plan, northwind, insurer]);
  await client.query(
    `INSERT INTO patient_policies (id, organization_id, patient_id, plan_id, member_number, valid_until) VALUES ($1,$2,$3,$4,'SB-229184', CURRENT_DATE + 200)`,
    [policy, northwind, patientIds['Maya Rahman'], plan]
  );
  await client.query(
    `INSERT INTO claims (organization_id, patient_id, policy_id, invoice_id, amount, status, submitted_on, notes) VALUES
     ($1,$2,$3,$4,2800,'submitted', CURRENT_DATE, 'Consultation claim'),
     ($1,$5,$3,NULL,1800,'rejected', CURRENT_DATE - 5, 'Member number did not match the plan year.')`,
    [northwind, patientIds['Maya Rahman'], policy, invoiceOpen, patientIds['Arjun Mehta']]
  );

  await client.query(
    `INSERT INTO shifts (organization_id, clinic_id, name, start_time, end_time) VALUES
     ($1,$2,'Morning','08:00','14:00'), ($1,$2,'Evening','14:00','20:00')`,
    [northwind, harbor]
  );
  await client.query(
    `INSERT INTO attendance (organization_id, user_id, clinic_id, work_date, clock_in, status) VALUES
     ($1,$2,$3, CURRENT_DATE, now() - interval '2 hours', 'present'),
     ($1,$4,$3, CURRENT_DATE, now() - interval '90 minutes', 'late')`,
    [northwind, users['nora@northwind.local'], harbor, users['rafi@northwind.local']]
  );
  await client.query(
    `INSERT INTO leave_requests (organization_id, user_id, starts_on, ends_on, leave_type, status, reason)
     VALUES ($1,$2, CURRENT_DATE + 5, CURRENT_DATE + 6, 'annual', 'pending', 'Family travel')`,
    [northwind, users['lina@northwind.local']]
  );

  await client.query(
    `INSERT INTO notifications (organization_id, user_id, patient_id, channel, title, body, status, trigger_key) VALUES
     ($1,$2,$3,'in_app','Appointment today','Maya Rahman is booked at 09:00 with Dr. Hassan Ali.','sent','appointment.reminder'),
     ($1,$2,$3,'sms','Appointment reminder','Harbor Clinic: your visit is today at 09:00.','queued','appointment.reminder'),
     ($1,NULL,$4,'email','Lab result entered','A complete blood count has been resulted.','queued','lab.resulted'),
     ($1,$5,NULL,'in_app','Low stock','Salbutamol inhalers are below the reorder level.','sent','stock.low')`,
    [northwind, users['maya@northwind.local'], patientIds['Maya Rahman'], patientIds['Fatima Noor'], users['samir@northwind.local']]
  );
  await client.query(
    `INSERT INTO consult_messages (organization_id, appointment_id, sender_id, body)
     VALUES ($1,$2,$3,'I am in the virtual room whenever you are ready.')`,
    [northwind, appointmentIds[patientIds['Elena Petrova']], hassan]
  );
  await client.query(
    `INSERT INTO integrations (organization_id, provider, category, config, enabled) VALUES
     ($1,'Jazz CPaaS','sms','{"note":"Add the SMS sender credentials to start delivery."}'::jsonb,false),
     ($1,'Meta Cloud API','whatsapp','{"note":"WhatsApp messages stay queued until a business number is connected."}'::jsonb,false),
     ($1,'SMTP','email','{"note":"Set a clinic mailbox to send invoices and results."}'::jsonb,false),
     ($1,'Stripe','payments','{"note":"Online card capture is recorded manually until a gateway key is added."}'::jsonb,false),
     ($1,'Orthanc','pacs','{"note":"Point this at your DICOMweb endpoint for imaging."}'::jsonb,false)`,
    [northwind]
  );
  await client.query(
    `INSERT INTO activity_logs (organization_id, user_id, action, entity, metadata) VALUES
     ($1,$2,'patient.created','patients','{"mrn":"NOR-1001"}'::jsonb),
     ($1,$3,'appointment.booked','appointments','{"visit":"today"}'::jsonb)`,
    [northwind, users['rafi@northwind.local'], users['leila@northwind.local']]
  );

  const customRole = id();
  await client.query(
    `INSERT INTO roles (id, organization_id, key, name, description, is_system) VALUES ($1,$2,'front_desk_lead','Front Desk Lead','Reception plus billing.',false)`,
    [customRole, northwind]
  );
  for (const permission of ['patients.read', 'patients.write', 'appointments.read', 'appointments.write', 'billing.read', 'billing.write', 'notifications.read']) {
    await client.query(`INSERT INTO role_permissions (role_id, permission_key, organization_id) VALUES ($1,$2,$3)`, [customRole, permission, northwind]);
  }
}

async function main() {
  const appRole = await ensureRole();
  await applySchema(appRole);
  if (appRole) {
    await adminQuery(`ALTER ROLE atrium_app SET search_path TO atrium, public`);
  }
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET search_path TO atrium, public');
    await upsertCatalog(client);
    const passwordHash = await hashPassword(process.env.DEMO_PASSWORD || 'Linden#2026');
    await seedDemo(client, passwordHash);
    await client.query('COMMIT');
    console.log('Linden database is ready.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await adminPool.end();
  }
}

main();
