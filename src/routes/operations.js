import { Router } from 'express';
import { q, tx } from '../db.js';
import { asyncRoute, HttpError } from '../http.js';
import { requireAuth, requireAny, requirePermission } from '../auth.js';
import { assertClinic, audit, clinicClause, nextInvoiceNumber, notify, patientClause, requireOrg } from '../scope.js';

const router = Router();
router.use(requireAuth);

router.get('/medicines', requireAny('pharmacy.read', 'prescriptions.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const { rows } = await q(
    req,
    `SELECT m.*, COALESCE(SUM(b.quantity), 0)::int AS on_hand,
            MIN(b.expiry_on) FILTER (WHERE b.quantity > 0) AS next_expiry
     FROM medicines m
     LEFT JOIN stock_batches b ON b.medicine_id = m.id
     WHERE m.organization_id = $1
     GROUP BY m.id
     ORDER BY m.name`,
    [org]
  );
  res.json({ medicines: rows });
}));

router.post('/medicines', requirePermission('pharmacy.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (!req.body?.name) throw new HttpError(400, 'Medicine name is required.');
  const { rows } = await q(
    req,
    `INSERT INTO medicines (organization_id, name, generic_name, brand_name, form, strength, unit, reorder_level, sell_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [org, req.body.name, req.body.genericName || null, req.body.brandName || null, req.body.form || null, req.body.strength || null, req.body.unit || 'unit', Number(req.body.reorderLevel || 20), Number(req.body.sellPrice || 0)]
  );
  res.status(201).json({ medicine: rows[0] });
}));

router.get('/stock', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org];
  const clinic = clinicClause(req, 'b.clinic_id', params);
  const { rows } = await q(
    req,
    `SELECT b.*, m.name AS medicine_name, m.generic_name, c.name AS clinic_name, s.name AS supplier_name
     FROM stock_batches b
     JOIN medicines m ON m.id = b.medicine_id
     JOIN clinics c ON c.id = b.clinic_id
     LEFT JOIN suppliers s ON s.id = b.supplier_id
     WHERE b.organization_id = $1 ${clinic}
     ORDER BY b.expiry_on NULLS LAST`,
    params
  );
  res.json({ batches: rows });
}));

router.post('/pharmacy/dispense', requirePermission('pharmacy.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  const clinicId = req.body?.clinicId || req.clinicId;
  if (!req.body?.patientId || !clinicId || !lines.length) throw new HttpError(400, 'Patient, branch, and medicines are required.');
  assertClinic(req, clinicId);
  const invoice = await tx(req, async (client) => {
    let subtotal = 0;
    const prepared = [];
    for (const line of lines) {
      const qty = Number(line.quantity || 0);
      if (!line.medicineId || qty <= 0) continue;
      const batches = await client.query(
        `SELECT * FROM stock_batches
         WHERE organization_id = $1 AND clinic_id = $2 AND medicine_id = $3 AND quantity > 0
         ORDER BY expiry_on NULLS LAST
         FOR UPDATE`,
        [org, clinicId, line.medicineId]
      );
      let remaining = qty;
      for (const batch of batches.rows) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, batch.quantity);
        await client.query(`UPDATE stock_batches SET quantity = quantity - $1 WHERE id = $2`, [take, batch.id]);
        await client.query(
          `INSERT INTO stock_movements (organization_id, clinic_id, medicine_id, batch_id, movement_type, quantity, reason, created_by)
           VALUES ($1,$2,$3,$4,'sale',$5,$6,$7)`,
          [org, clinicId, line.medicineId, batch.id, -take, 'Pharmacy dispense', req.user.id]
        );
        remaining -= take;
      }
      if (remaining > 0) throw new HttpError(409, 'Not enough stock to dispense that quantity.');
      const medicine = await client.query(`SELECT name, sell_price FROM medicines WHERE id = $1 AND organization_id = $2`, [line.medicineId, org]);
      const amount = Number(medicine.rows[0].sell_price) * qty;
      subtotal += amount;
      prepared.push({ description: medicine.rows[0].name, quantity: qty, unitPrice: medicine.rows[0].sell_price, amount });
    }
    if (!prepared.length) throw new HttpError(400, 'Add at least one medicine.');
    const number = await nextInvoiceNumber(client, org);
    const created = await client.query(
      `INSERT INTO invoices (organization_id, clinic_id, patient_id, number, category, status, subtotal, total, balance)
       VALUES ($1,$2,$3,$4,'pharmacy','open',$5,$5,$5) RETURNING *`,
      [org, clinicId, req.body.patientId, number, subtotal]
    );
    for (const line of prepared) {
      await client.query(
        `INSERT INTO invoice_lines (organization_id, invoice_id, description, quantity, unit_price, amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [org, created.rows[0].id, line.description, line.quantity, line.unitPrice, line.amount]
      );
    }
    if (req.body.prescriptionId) {
      await client.query(`UPDATE prescriptions SET status = 'dispensed' WHERE id = $1 AND organization_id = $2`, [req.body.prescriptionId, org]);
    }
    await notify(client, {
      organizationId: org,
      patientId: req.body.patientId,
      title: 'Pharmacy bill',
      body: `${number} is ready for payment.`,
      triggerKey: 'pharmacy.dispensed',
      channels: ['in_app']
    });
    await audit(client, req, 'pharmacy.dispensed', 'invoices', created.rows[0].id);
    return created.rows[0];
  });
  res.status(201).json({ invoice });
}));

router.get('/suppliers', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const { rows } = await q(req, `SELECT * FROM suppliers WHERE organization_id = $1 ORDER BY name`, [org]);
  res.json({ suppliers: rows });
}));

router.post('/suppliers', requirePermission('inventory.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (!req.body?.name) throw new HttpError(400, 'Supplier name is required.');
  const { rows } = await q(
    req,
    `INSERT INTO suppliers (organization_id, name, phone, email, address) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [org, req.body.name, req.body.phone || null, req.body.email || null, req.body.address || null]
  );
  res.status(201).json({ supplier: rows[0] });
}));

router.get('/purchase-orders', requirePermission('inventory.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const { rows } = await q(
    req,
    `SELECT po.*, s.name AS supplier_name, c.name AS clinic_name,
            COALESCE(json_agg(json_build_object('id', i.id, 'medicineId', i.medicine_id, 'medicine', m.name, 'quantity', i.quantity, 'unitCost', i.unit_cost))
              FILTER (WHERE i.id IS NOT NULL), '[]') AS items
     FROM purchase_orders po
     LEFT JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN clinics c ON c.id = po.clinic_id
     LEFT JOIN purchase_order_items i ON i.purchase_order_id = po.id
     LEFT JOIN medicines m ON m.id = i.medicine_id
     WHERE po.organization_id = $1
     GROUP BY po.id, s.id, c.id
     ORDER BY po.ordered_on DESC`,
    [org]
  );
  res.json({ orders: rows });
}));

router.post('/purchase-orders', requirePermission('inventory.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const clinicId = req.body?.clinicId || req.clinicId;
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!clinicId || !items.length) throw new HttpError(400, 'Branch and line items are required.');
  assertClinic(req, clinicId);
  const order = await tx(req, async (client) => {
    const created = await client.query(
      `INSERT INTO purchase_orders (organization_id, clinic_id, supplier_id, status, notes)
       VALUES ($1,$2,$3,'ordered',$4) RETURNING *`,
      [org, clinicId, req.body.supplierId || null, req.body.notes || null]
    );
    for (const item of items) {
      await client.query(
        `INSERT INTO purchase_order_items (organization_id, purchase_order_id, medicine_id, quantity, unit_cost)
         VALUES ($1,$2,$3,$4,$5)`,
        [org, created.rows[0].id, item.medicineId, Number(item.quantity), Number(item.unitCost || 0)]
      );
    }
    return created.rows[0];
  });
  res.status(201).json({ order });
}));

router.post('/purchase-orders/:id/receive', requirePermission('inventory.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  await tx(req, async (client) => {
    const order = await client.query(`SELECT * FROM purchase_orders WHERE id = $1 AND organization_id = $2`, [req.params.id, org]);
    if (!order.rowCount) throw new HttpError(404, 'Purchase order not found.');
    if (order.rows[0].status === 'received') throw new HttpError(409, 'This order is already received.');
    const items = await client.query(`SELECT * FROM purchase_order_items WHERE purchase_order_id = $1`, [req.params.id]);
    for (const item of items.rows) {
      const batchNo = req.body?.batchNo || `GRN-${Date.now().toString().slice(-6)}`;
      const batch = await client.query(
        `INSERT INTO stock_batches (organization_id, clinic_id, medicine_id, supplier_id, batch_no, expiry_on, quantity, cost_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [org, order.rows[0].clinic_id, item.medicine_id, order.rows[0].supplier_id, batchNo, req.body?.expiryOn || null, item.quantity, item.unit_cost]
      );
      await client.query(
        `INSERT INTO stock_movements (organization_id, clinic_id, medicine_id, batch_id, movement_type, quantity, reason, created_by)
         VALUES ($1,$2,$3,$4,'receipt',$5,'Goods received',$6)`,
        [org, order.rows[0].clinic_id, item.medicine_id, batch.rows[0].id, item.quantity, req.user.id]
      );
    }
    await client.query(`UPDATE purchase_orders SET status = 'received' WHERE id = $1`, [req.params.id]);
    await audit(client, req, 'inventory.received', 'purchase_orders', req.params.id);
  });
  res.json({ ok: true });
}));

router.post('/stock/adjust', requirePermission('inventory.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const quantity = Number(req.body?.quantity);
  if (!req.body?.batchId || !Number.isFinite(quantity)) throw new HttpError(400, 'Batch and quantity are required.');
  await tx(req, async (client) => {
    const batch = await client.query(`SELECT * FROM stock_batches WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [req.body.batchId, org]);
    if (!batch.rowCount) throw new HttpError(404, 'Batch not found.');
    const next = batch.rows[0].quantity + quantity;
    if (next < 0) throw new HttpError(409, 'Adjustment would make stock negative.');
    await client.query(`UPDATE stock_batches SET quantity = $1 WHERE id = $2`, [next, req.body.batchId]);
    await client.query(
      `INSERT INTO stock_movements (organization_id, clinic_id, medicine_id, batch_id, movement_type, quantity, reason, created_by)
       VALUES ($1,$2,$3,$4,'adjustment',$5,$6,$7)`,
      [org, batch.rows[0].clinic_id, batch.rows[0].medicine_id, req.body.batchId, quantity, req.body.reason || 'Stock adjustment', req.user.id]
    );
  });
  res.json({ ok: true });
}));

router.post('/stock/transfer', requirePermission('inventory.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const quantity = Number(req.body?.quantity);
  if (!req.body?.batchId || !req.body?.toClinicId || quantity <= 0) throw new HttpError(400, 'Batch, destination, and quantity are required.');
  assertClinic(req, req.body.toClinicId);
  await tx(req, async (client) => {
    const batch = await client.query(`SELECT * FROM stock_batches WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [req.body.batchId, org]);
    if (!batch.rowCount) throw new HttpError(404, 'Batch not found.');
    if (batch.rows[0].quantity < quantity) throw new HttpError(409, 'Not enough quantity in that batch.');
    await client.query(`UPDATE stock_batches SET quantity = quantity - $1 WHERE id = $2`, [quantity, batch.rows[0].id]);
    await client.query(
      `INSERT INTO stock_batches (organization_id, clinic_id, medicine_id, supplier_id, batch_no, expiry_on, quantity, cost_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [org, req.body.toClinicId, batch.rows[0].medicine_id, batch.rows[0].supplier_id, `${batch.rows[0].batch_no}-T`, batch.rows[0].expiry_on, quantity, batch.rows[0].cost_price]
    );
    await client.query(
      `INSERT INTO stock_movements (organization_id, clinic_id, medicine_id, batch_id, movement_type, quantity, reason, created_by)
       VALUES ($1,$2,$3,$4,'transfer_out',$5,'Branch transfer',$6)`,
      [org, batch.rows[0].clinic_id, batch.rows[0].medicine_id, batch.rows[0].id, -quantity, req.user.id]
    );
    await audit(client, req, 'inventory.transferred', 'stock_batches', req.body.batchId, { quantity });
  });
  res.json({ ok: true });
}));

router.get('/invoices', requirePermission('billing.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const params = [org];
  const own = patientClause(req, 'i.patient_id', params);
  const clinic = clinicClause(req, 'i.clinic_id', params);
  const { rows } = await q(
    req,
    `SELECT i.*, p.first_name, p.last_name, p.mrn, c.name AS clinic_name,
            COALESCE(json_agg(json_build_object('description', l.description, 'quantity', l.quantity, 'unitPrice', l.unit_price, 'amount', l.amount))
              FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
     FROM invoices i
     LEFT JOIN patients p ON p.id = i.patient_id
     LEFT JOIN clinics c ON c.id = i.clinic_id
     LEFT JOIN invoice_lines l ON l.invoice_id = i.id
     WHERE i.organization_id = $1 ${own} ${clinic}
     GROUP BY i.id, p.id, c.id
     ORDER BY i.issued_at DESC LIMIT 100`,
    params
  );
  res.json({ invoices: rows });
}));

router.post('/invoices', requirePermission('billing.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const lines = Array.isArray(req.body?.lines) ? req.body.lines.filter((line) => line.description) : [];
  if (!lines.length) throw new HttpError(400, 'Add at least one charge.');
  const clinicId = req.body?.clinicId || req.clinicId;
  assertClinic(req, clinicId);
  const categories = ['consultation', 'lab', 'pharmacy', 'procedure', 'package', 'imaging', 'other'];
  const category = categories.includes(req.body?.category) ? req.body.category : 'other';
  const payers = ['patient', 'insurance', 'corporate'];
  const invoice = await tx(req, async (client) => {
    const subtotal = lines.reduce((sum, line) => sum + Number(line.quantity || 1) * Number(line.unitPrice || 0), 0);
    const discount = Math.min(Number(req.body?.discount || 0), subtotal);
    const tax = Number(req.body?.tax || 0);
    const total = Math.max(subtotal - discount + tax, 0);
    const number = await nextInvoiceNumber(client, org);
    const created = await client.query(
      `INSERT INTO invoices (
         organization_id, clinic_id, patient_id, doctor_id, number, category, payer_type, payer_name,
         status, subtotal, discount, tax, total, balance, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$12,$13) RETURNING *`,
      [
        org, clinicId || null, req.body.patientId || null, req.body.doctorId || null, number, category,
        payers.includes(req.body?.payerType) ? req.body.payerType : 'patient', req.body.payerName || null,
        subtotal, discount, tax, total, req.body.notes || null
      ]
    );
    for (const line of lines) {
      const quantity = Number(line.quantity || 1);
      const unitPrice = Number(line.unitPrice || 0);
      await client.query(
        `INSERT INTO invoice_lines (organization_id, invoice_id, description, quantity, unit_price, amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [org, created.rows[0].id, line.description, quantity, unitPrice, quantity * unitPrice]
      );
    }
    await notify(client, {
      organizationId: org,
      patientId: req.body.patientId || null,
      title: 'Invoice issued',
      body: `${number} totals ${total.toFixed(2)}.`,
      triggerKey: 'invoice.issued',
      channels: ['in_app', 'email']
    });
    await audit(client, req, 'invoice.created', 'invoices', created.rows[0].id);
    return created.rows[0];
  });
  res.status(201).json({ invoice });
}));

router.post('/invoices/:id/payments', requirePermission('billing.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const amount = Number(req.body?.amount);
  const methods = ['cash', 'card', 'transfer', 'insurance', 'online'];
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Enter a payment amount.');
  const method = methods.includes(req.body?.method) ? req.body.method : 'cash';
  const kind = req.body?.kind === 'refund' ? 'refund' : 'payment';
  const payment = await tx(req, async (client) => {
    const invoice = await client.query(`SELECT * FROM invoices WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [req.params.id, org]);
    if (!invoice.rowCount) throw new HttpError(404, 'Invoice not found.');
    const current = invoice.rows[0];
    const delta = kind === 'refund' ? amount : -amount;
    const balance = Number(current.balance) + delta;
    if (kind === 'payment' && amount - Number(current.balance) > 0.001) throw new HttpError(409, 'Payment is larger than the balance.');
    if (kind === 'refund' && balance - Number(current.total) > 0.001) throw new HttpError(409, 'Refund exceeds the amount collected.');
    const status = balance <= 0.001 ? 'paid' : kind === 'refund' && balance >= Number(current.total) ? 'open' : 'partial';
    await client.query(`UPDATE invoices SET balance = $1, status = $2 WHERE id = $3`, [Math.max(balance, 0), status, current.id]);
    const created = await client.query(
      `INSERT INTO payments (organization_id, invoice_id, amount, method, kind, reference, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [org, current.id, amount, method, kind, req.body.reference || null, req.user.id]
    );
    await notify(client, {
      organizationId: org,
      patientId: current.patient_id,
      title: kind === 'refund' ? 'Refund recorded' : 'Payment received',
      body: `${amount.toFixed(2)} via ${method} on ${current.number}.`,
      triggerKey: kind === 'refund' ? 'payment.refund' : 'payment.received',
      channels: ['in_app', 'email']
    });
    await audit(client, req, `payment.${kind}`, 'payments', created.rows[0].id);
    return created.rows[0];
  });
  res.status(201).json({ payment });
}));

router.get('/insurers', requirePermission('insurance.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const insurers = await q(req, `SELECT * FROM insurers WHERE organization_id = $1 ORDER BY name`, [org]);
  const plans = await q(
    req,
    `SELECT ip.*, i.name AS insurer_name FROM insurance_plans ip JOIN insurers i ON i.id = ip.insurer_id WHERE ip.organization_id = $1`,
    [org]
  );
  const claims = await q(
    req,
    `SELECT c.*, p.first_name, p.last_name, p.mrn FROM claims c JOIN patients p ON p.id = c.patient_id
     WHERE c.organization_id = $1 ORDER BY c.created_at DESC`,
    [org]
  );
  res.json({ insurers: insurers.rows, plans: plans.rows, claims: claims.rows });
}));

router.post('/insurers', requirePermission('insurance.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (!req.body?.name) throw new HttpError(400, 'Insurer name is required.');
  const { rows } = await q(
    req,
    `INSERT INTO insurers (organization_id, name, phone, email, address) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [org, req.body.name, req.body.phone || null, req.body.email || null, req.body.address || null]
  );
  res.status(201).json({ insurer: rows[0] });
}));

router.post('/insurance/plans', requirePermission('insurance.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (!req.body?.insurerId || !req.body?.name) throw new HttpError(400, 'Insurer and plan name are required.');
  const { rows } = await q(
    req,
    `INSERT INTO insurance_plans (organization_id, insurer_id, name, coverage_percent, notes)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [org, req.body.insurerId, req.body.name, Number(req.body.coveragePercent || 80), req.body.notes || null]
  );
  res.status(201).json({ plan: rows[0] });
}));

router.post('/insurance/policies', requirePermission('insurance.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (!req.body?.patientId || !req.body?.planId || !req.body?.memberNumber) throw new HttpError(400, 'Patient, plan, and member number are required.');
  const { rows } = await q(
    req,
    `INSERT INTO patient_policies (organization_id, patient_id, plan_id, member_number, valid_until, status)
     VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
    [org, req.body.patientId, req.body.planId, req.body.memberNumber, req.body.validUntil || null]
  );
  res.status(201).json({ policy: rows[0] });
}));

router.post('/claims', requirePermission('insurance.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const amount = Number(req.body?.amount);
  if (!req.body?.patientId || !Number.isFinite(amount)) throw new HttpError(400, 'Patient and amount are required.');
  const { rows } = await q(
    req,
    `INSERT INTO claims (organization_id, patient_id, policy_id, invoice_id, amount, status, submitted_on, notes)
     VALUES ($1,$2,$3,$4,$5,$6, CURRENT_DATE, $7) RETURNING *`,
    [org, req.body.patientId, req.body.policyId || null, req.body.invoiceId || null, amount, req.body.status === 'draft' ? 'draft' : 'submitted', req.body.notes || null]
  );
  res.status(201).json({ claim: rows[0] });
}));

router.patch('/claims/:id', requirePermission('insurance.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const statuses = ['draft', 'submitted', 'approved', 'rejected', 'paid'];
  if (!statuses.includes(req.body?.status)) throw new HttpError(400, 'Unknown claim status.');
  const { rows } = await q(
    req,
    `UPDATE claims SET status = $3, notes = COALESCE($4, notes) WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [org, req.params.id, req.body.status, req.body.notes || null]
  );
  if (!rows[0]) throw new HttpError(404, 'Claim not found.');
  res.json({ claim: rows[0] });
}));

router.get('/hr', requirePermission('hr.read'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  const staff = await q(
    req,
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, r.name AS role_name, r.key AS role_key,
            sp.designation, sp.specialization, c.name AS clinic_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN staff_profiles sp ON sp.user_id = u.id
     LEFT JOIN clinics c ON c.id = u.clinic_id
     WHERE u.organization_id = $1 AND r.key <> 'patient'
     ORDER BY u.full_name`,
    [org]
  );
  const attendance = await q(
    req,
    `SELECT a.*, u.full_name FROM attendance a JOIN users u ON u.id = a.user_id
     WHERE a.organization_id = $1 AND a.work_date = CURRENT_DATE ORDER BY u.full_name`,
    [org]
  );
  const leave = await q(
    req,
    `SELECT l.*, u.full_name FROM leave_requests l JOIN users u ON u.id = l.user_id
     WHERE l.organization_id = $1 ORDER BY l.created_at DESC`,
    [org]
  );
  const shifts = await q(req, `SELECT s.*, c.name AS clinic_name FROM shifts s JOIN clinics c ON c.id = s.clinic_id WHERE s.organization_id = $1`, [org]);
  res.json({ staff: staff.rows, attendance: attendance.rows, leave: leave.rows, shifts: shifts.rows });
}));

router.post('/hr/attendance', requirePermission('hr.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (!req.body?.userId) throw new HttpError(400, 'Choose a staff member.');
  const { rows } = await q(
    req,
    `INSERT INTO attendance (organization_id, user_id, clinic_id, work_date, clock_in, status)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), now(), $5)
     ON CONFLICT (user_id, work_date)
     DO UPDATE SET clock_out = now(), status = EXCLUDED.status
     RETURNING *`,
    [org, req.body.userId, req.body.clinicId || req.clinicId, req.body.workDate || null, req.body.status || 'present']
  );
  res.status(201).json({ attendance: rows[0] });
}));

router.post('/hr/leave', requirePermission('hr.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (!req.body?.userId || !req.body?.startsOn || !req.body?.endsOn) throw new HttpError(400, 'Staff member and dates are required.');
  const { rows } = await q(
    req,
    `INSERT INTO leave_requests (organization_id, user_id, starts_on, ends_on, leave_type, reason, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [org, req.body.userId, req.body.startsOn, req.body.endsOn, req.body.leaveType || 'annual', req.body.reason || null, req.body.status || 'pending']
  );
  res.status(201).json({ leave: rows[0] });
}));

router.patch('/hr/leave/:id', requirePermission('hr.write'), asyncRoute(async (req, res) => {
  const org = requireOrg(req);
  if (!['approved', 'rejected', 'pending'].includes(req.body?.status)) throw new HttpError(400, 'Unknown leave status.');
  const { rows } = await q(
    req,
    `UPDATE leave_requests SET status = $3 WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [org, req.params.id, req.body.status]
  );
  if (!rows[0]) throw new HttpError(404, 'Leave request not found.');
  res.json({ leave: rows[0] });
}));

export default router;
