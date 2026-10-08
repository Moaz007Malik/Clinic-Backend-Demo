-- Linden clinic OS. All product tables live in the atrium schema.
-- Tenant isolation is row-level: every business row carries organization_id,
-- and atrium_app is subject to FORCE ROW LEVEL SECURITY.

CREATE SCHEMA IF NOT EXISTS atrium;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

SET search_path TO atrium, public;

CREATE OR REPLACE FUNCTION atrium.app_is_super() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.is_super', true) = 'true';
$$;

CREATE OR REPLACE FUNCTION atrium.app_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION atrium.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  legal_name text,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'suspended', 'inactive')),
  logo_url text,
  primary_color text NOT NULL DEFAULT '#1c6b52',
  accent_color text NOT NULL DEFAULT '#c56a32',
  email text,
  phone text,
  website text,
  address text,
  city text,
  country text,
  timezone text NOT NULL DEFAULT 'UTC',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  price_monthly numeric(12,2) NOT NULL DEFAULT 0,
  price_yearly numeric(12,2) NOT NULL DEFAULT 0,
  max_users int,
  max_patients int,
  max_branches int,
  max_storage_mb int,
  sms_quota int,
  whatsapp_quota int,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_public boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing', 'active', 'past_due', 'suspended', 'canceled')),
  billing_cycle text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  number text NOT NULL,
  amount numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'paid', 'void')),
  issued_on date NOT NULL DEFAULT CURRENT_DATE,
  due_on date,
  paid_on date
);

CREATE TABLE IF NOT EXISTS permissions (
  key text PRIMARY KEY,
  module text NOT NULL,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  UNIQUE (organization_id, key)
);

CREATE UNIQUE INDEX IF NOT EXISTS roles_system_key_idx ON roles (key) WHERE organization_id IS NULL;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL,
  phone text,
  email text,
  address text,
  city text,
  timezone text NOT NULL DEFAULT 'UTC',
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  name text NOT NULL,
  room_type text NOT NULL CHECK (room_type IN ('consultation', 'operation')),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'maintenance'))
);

CREATE TABLE IF NOT EXISTS wards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL,
  ward_type text NOT NULL DEFAULT 'general'
);

CREATE TABLE IF NOT EXISTS beds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  ward_id uuid NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'maintenance'))
);

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL,
  base_price numeric(12,2) NOT NULL DEFAULT 0,
  duration_minutes int NOT NULL DEFAULT 20,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS service_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  price numeric(12,2) NOT NULL,
  UNIQUE (service_id, clinic_id)
);

CREATE TABLE IF NOT EXISTS working_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  weekday int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens time,
  closes time,
  is_closed boolean NOT NULL DEFAULT false,
  UNIQUE (clinic_id, weekday)
);

CREATE TABLE IF NOT EXISTS holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL,
  holiday_on date NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid REFERENCES clinics(id) ON DELETE SET NULL,
  patient_id uuid,
  role_id uuid NOT NULL REFERENCES roles(id),
  email text NOT NULL,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  phone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_secret text,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_org_idx
  ON users (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(email));

CREATE TABLE IF NOT EXISTS user_clinics (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, clinic_id)
);

CREATE TABLE IF NOT EXISTS user_departments (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, department_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  ip text,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  email text,
  ip text,
  user_agent text,
  success boolean NOT NULL,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity text,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid REFERENCES clinics(id) ON DELETE SET NULL,
  portal_user_id uuid,
  mrn text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  dob date,
  sex text CHECK (sex IN ('female', 'male', 'other', 'unknown')),
  blood_group text,
  phone text,
  email text,
  address text,
  city text,
  national_id text,
  photo_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, mrn)
);

CREATE TABLE IF NOT EXISTS mrn_counters (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  next_value int NOT NULL DEFAULT 1001
);

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name text NOT NULL,
  relationship text,
  phone text NOT NULL
);

CREATE TABLE IF NOT EXISTS allergies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  substance text NOT NULL,
  reaction text,
  severity text NOT NULL DEFAULT 'moderate' CHECK (severity IN ('mild', 'moderate', 'severe')),
  noted_on date NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'chronic')),
  diagnosed_on date,
  notes text
);

CREATE TABLE IF NOT EXISTS surgeries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  procedure_name text NOT NULL,
  performed_on date,
  facility text,
  notes text
);

CREATE TABLE IF NOT EXISTS family_histories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  relation text NOT NULL,
  condition text NOT NULL,
  notes text
);

CREATE TABLE IF NOT EXISTS patient_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'other',
  file_url text,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  consent_type text NOT NULL,
  granted boolean NOT NULL,
  notes text,
  recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  designation text,
  specialization text,
  qualifications text,
  license_number text,
  license_expires_on date,
  consultation_fee numeric(12,2) NOT NULL DEFAULT 0,
  commission_percent numeric(5,2) NOT NULL DEFAULT 0,
  bio text
);

CREATE TABLE IF NOT EXISTS doctor_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  weekday int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  slot_minutes int NOT NULL DEFAULT 20
);

CREATE TABLE IF NOT EXISTS doctor_leaves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  visit_type text NOT NULL DEFAULT 'in_person' CHECK (visit_type IN ('in_person', 'walk_in', 'telemedicine')),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'confirmed', 'checked_in', 'in_consult', 'completed', 'cancelled', 'no_show')),
  reason text,
  notes text,
  token_number int,
  queue_status text NOT NULL DEFAULT 'booked' CHECK (queue_status IN ('booked', 'waiting', 'called', 'done')),
  room_url text,
  series_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS waiting_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  preferred_on date,
  notes text,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'booked', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS encounters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid REFERENCES clinics(id) ON DELETE SET NULL,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  subjective text,
  objective text,
  assessment text,
  plan text,
  symptoms text,
  diagnosis text,
  follow_up_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vitals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  encounter_id uuid REFERENCES encounters(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  systolic int,
  diastolic int,
  pulse int,
  temperature_c numeric(4,1),
  spo2 int,
  respiratory_rate int,
  weight_kg numeric(6,2),
  height_cm numeric(6,1),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  encounter_id uuid REFERENCES encounters(id) ON DELETE SET NULL,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  referred_to text NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'sent', 'closed'))
);

CREATE TABLE IF NOT EXISTS medical_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  encounter_id uuid REFERENCES encounters(id) ON DELETE SET NULL,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  summary text NOT NULL,
  issued_on date NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  encounter_id uuid REFERENCES encounters(id) ON DELETE SET NULL,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dispensed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prescription_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  prescription_id uuid NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  medicine_name text NOT NULL,
  generic_name text,
  dosage text,
  frequency text,
  duration text,
  instructions text
);

CREATE TABLE IF NOT EXISTS medicines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  generic_name text,
  brand_name text,
  form text,
  strength text,
  unit text NOT NULL DEFAULT 'unit',
  reorder_level int NOT NULL DEFAULT 20,
  sell_price numeric(12,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  email text,
  address text
);

CREATE TABLE IF NOT EXISTS stock_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  medicine_id uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  batch_no text NOT NULL,
  expiry_on date,
  quantity int NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  cost_price numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid REFERENCES clinics(id) ON DELETE SET NULL,
  medicine_id uuid REFERENCES medicines(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES stock_batches(id) ON DELETE SET NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('receipt', 'sale', 'adjustment', 'transfer_out', 'transfer_in', 'return')),
  quantity int NOT NULL,
  reason text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ordered', 'received', 'cancelled')),
  ordered_on date NOT NULL DEFAULT CURRENT_DATE,
  notes text
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  medicine_id uuid NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
  quantity int NOT NULL CHECK (quantity > 0),
  unit_cost numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS lab_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  sample_type text,
  price numeric(12,2) NOT NULL DEFAULT 0,
  unit text,
  ref_low numeric(12,3),
  ref_high numeric(12,3),
  ref_text text,
  turnaround_hours int NOT NULL DEFAULT 24,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS lab_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid REFERENCES clinics(id) ON DELETE SET NULL,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  encounter_id uuid REFERENCES encounters(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'collected', 'resulted', 'approved', 'cancelled')),
  priority text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'urgent')),
  notes text,
  ordered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lab_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lab_order_id uuid NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
  lab_test_id uuid NOT NULL REFERENCES lab_tests(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'collected', 'resulted', 'approved')),
  result_value text,
  result_unit text,
  flag text,
  remarks text,
  entered_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  collected_at timestamptz,
  resulted_at timestamptz
);

CREATE TABLE IF NOT EXISTS imaging_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid REFERENCES clinics(id) ON DELETE SET NULL,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  technician_id uuid REFERENCES users(id) ON DELETE SET NULL,
  radiologist_id uuid REFERENCES users(id) ON DELETE SET NULL,
  modality text NOT NULL CHECK (modality IN ('xray', 'ultrasound', 'ct', 'mri', 'other')),
  study_name text NOT NULL,
  status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'acquired', 'reported', 'approved', 'cancelled')),
  clinical_info text,
  report text,
  attachment_url text,
  ordered_at timestamptz NOT NULL DEFAULT now(),
  reported_at timestamptz
);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid REFERENCES clinics(id) ON DELETE SET NULL,
  patient_id uuid REFERENCES patients(id) ON DELETE SET NULL,
  doctor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  number text NOT NULL,
  category text NOT NULL DEFAULT 'consultation' CHECK (category IN ('consultation', 'lab', 'pharmacy', 'procedure', 'package', 'imaging', 'other')),
  payer_type text NOT NULL DEFAULT 'patient' CHECK (payer_type IN ('patient', 'insurance', 'corporate')),
  payer_name text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'partial', 'paid', 'void')),
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  discount numeric(12,2) NOT NULL DEFAULT 0,
  tax numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  balance numeric(12,2) NOT NULL DEFAULT 0,
  notes text,
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  amount numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('cash', 'card', 'transfer', 'insurance', 'online')),
  kind text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'refund')),
  reference text,
  received_by uuid REFERENCES users(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS insurers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  email text,
  address text
);

CREATE TABLE IF NOT EXISTS insurance_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  insurer_id uuid NOT NULL REFERENCES insurers(id) ON DELETE CASCADE,
  name text NOT NULL,
  coverage_percent numeric(5,2) NOT NULL DEFAULT 80,
  notes text
);

CREATE TABLE IF NOT EXISTS patient_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES insurance_plans(id) ON DELETE CASCADE,
  member_number text NOT NULL,
  valid_until date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'pending'))
);

CREATE TABLE IF NOT EXISTS claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  policy_id uuid REFERENCES patient_policies(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  amount numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'paid')),
  submitted_on date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name text NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id uuid REFERENCES clinics(id) ON DELETE SET NULL,
  work_date date NOT NULL DEFAULT CURRENT_DATE,
  clock_in timestamptz,
  clock_out timestamptz,
  status text NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'late', 'absent', 'leave')),
  UNIQUE (user_id, work_date)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  leave_type text NOT NULL DEFAULT 'annual',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  patient_id uuid REFERENCES patients(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'sms', 'whatsapp', 'push')),
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'read')),
  trigger_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE TABLE IF NOT EXISTS consult_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  category text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url text NOT NULL,
  event text NOT NULL,
  secret text,
  enabled boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS patients_org_idx ON patients (organization_id, last_name);
CREATE INDEX IF NOT EXISTS appointments_org_start_idx ON appointments (organization_id, starts_at);
CREATE INDEX IF NOT EXISTS invoices_org_idx ON invoices (organization_id, issued_at);
CREATE INDEX IF NOT EXISTS activity_org_idx ON activity_logs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

DROP TRIGGER IF EXISTS organizations_touch ON organizations;
CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION atrium.touch_updated_at();

-- Login and public branding run as the table owner so the app role can stay under RLS.
CREATE OR REPLACE FUNCTION atrium.auth_lookup(p_email text, p_slug text)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  clinic_id uuid,
  patient_id uuid,
  role_id uuid,
  email text,
  password_hash text,
  full_name text,
  phone text,
  status text,
  mfa_enabled boolean,
  mfa_secret text,
  role_key text,
  org_status text,
  org_slug text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = atrium, public
AS $$
  SELECT src.id, src.organization_id, src.clinic_id, src.patient_id, src.role_id, src.email,
         src.secret_hash, src.full_name, src.phone, src.status, src.mfa_enabled, src.mfa_secret,
         src.role_key, src.org_status, src.org_slug
  FROM (
    SELECT u.id, u.organization_id, u.clinic_id, u.patient_id, u.role_id, u.email,
           u.password_hash AS secret_hash, u.full_name, u.phone, u.status, u.mfa_enabled, u.mfa_secret,
           r.key AS role_key, o.status AS org_status, o.slug AS org_slug
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN organizations o ON o.id = u.organization_id
    WHERE lower(u.email) = lower(p_email)
      AND (
        (p_slug IS NULL AND u.organization_id IS NULL)
        OR (p_slug IS NOT NULL AND o.slug = p_slug)
      )
    LIMIT 1
  ) src;
$$;

CREATE OR REPLACE FUNCTION atrium.public_branding(p_slug text)
RETURNS TABLE (
  name text,
  slug text,
  logo_url text,
  primary_color text,
  accent_color text,
  email text,
  phone text,
  address text,
  city text,
  country text,
  status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = atrium, public
AS $$
  SELECT o.name, o.slug, o.logo_url, o.primary_color, o.accent_color, o.email, o.phone, o.address, o.city, o.country, o.status
  FROM organizations o
  WHERE o.slug = p_slug;
$$;

REVOKE ALL ON FUNCTION atrium.auth_lookup(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION atrium.public_branding(text) FROM PUBLIC;

DO $$
DECLARE
  tbl text;
  org_tables text[] := ARRAY[
    'subscriptions','saas_invoices','clinics','departments','rooms','wards','beds','services','service_prices',
    'working_hours','holidays','user_clinics','user_departments','patients','mrn_counters','emergency_contacts',
    'allergies','conditions','surgeries','family_histories','patient_documents','consents','staff_profiles',
    'doctor_schedules','doctor_leaves','appointments','waiting_list','encounters','vitals','referrals',
    'medical_certificates','prescriptions','prescription_items','medicines','suppliers','stock_batches',
    'stock_movements','purchase_orders','purchase_order_items','lab_tests','lab_orders','lab_order_items',
    'imaging_orders','invoices','invoice_lines','payments','insurers','insurance_plans','patient_policies',
    'claims','shifts','attendance','leave_requests','notifications','consult_messages','webhooks'
  ];
BEGIN
  FOREACH tbl IN ARRAY org_tables LOOP
    EXECUTE format('ALTER TABLE atrium.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE atrium.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON atrium.%I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON atrium.%I USING (atrium.app_is_super() OR organization_id = atrium.app_org()) WITH CHECK (atrium.app_is_super() OR organization_id = atrium.app_org())',
      tbl
    );
  END LOOP;
END
$$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organizations;
CREATE POLICY tenant_isolation ON organizations
  USING (atrium.app_is_super() OR id = atrium.app_org())
  WITH CHECK (atrium.app_is_super() OR id = atrium.app_org());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (atrium.app_is_super() OR organization_id = atrium.app_org())
  WITH CHECK (atrium.app_is_super() OR organization_id = atrium.app_org());

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sessions;
CREATE POLICY tenant_isolation ON sessions
  USING (atrium.app_is_super() OR organization_id = atrium.app_org())
  WITH CHECK (atrium.app_is_super() OR organization_id = atrium.app_org());

ALTER TABLE login_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON login_history;
CREATE POLICY tenant_isolation ON login_history
  USING (atrium.app_is_super() OR organization_id = atrium.app_org())
  WITH CHECK (atrium.app_is_super() OR organization_id = atrium.app_org());

ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON activity_logs;
CREATE POLICY tenant_isolation ON activity_logs
  USING (atrium.app_is_super() OR organization_id = atrium.app_org())
  WITH CHECK (atrium.app_is_super() OR organization_id = atrium.app_org());

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON roles;
CREATE POLICY tenant_read ON roles
  USING (atrium.app_is_super() OR organization_id = atrium.app_org() OR organization_id IS NULL)
  WITH CHECK (atrium.app_is_super() OR organization_id = atrium.app_org());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON role_permissions;
CREATE POLICY tenant_read ON role_permissions
  USING (atrium.app_is_super() OR organization_id IS NULL OR organization_id = atrium.app_org())
  WITH CHECK (atrium.app_is_super() OR organization_id = atrium.app_org());

ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_catalog ON permissions;
CREATE POLICY read_catalog ON permissions
  USING (true)
  WITH CHECK (atrium.app_is_super());

ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS read_catalog ON subscription_plans;
CREATE POLICY read_catalog ON subscription_plans
  USING (true)
  WITH CHECK (atrium.app_is_super());

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON integrations;
CREATE POLICY tenant_isolation ON integrations
  USING (atrium.app_is_super() OR organization_id = atrium.app_org())
  WITH CHECK (atrium.app_is_super() OR organization_id = atrium.app_org());

GRANT USAGE ON SCHEMA atrium TO atrium_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA atrium TO atrium_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA atrium TO atrium_app;
GRANT EXECUTE ON FUNCTION atrium.auth_lookup(text, text) TO atrium_app;
GRANT EXECUTE ON FUNCTION atrium.public_branding(text) TO atrium_app;
GRANT EXECUTE ON FUNCTION atrium.app_is_super() TO atrium_app;
GRANT EXECUTE ON FUNCTION atrium.app_org() TO atrium_app;
