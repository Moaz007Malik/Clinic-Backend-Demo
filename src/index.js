import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { assertDatabase } from './db.js';
import { HttpError } from './http.js';
import authRoutes from './routes/auth.js';
import patientRoutes from './routes/patients.js';
import appointmentRoutes from './routes/appointments.js';
import clinicalRoutes from './routes/clinical.js';
import operationsRoutes from './routes/operations.js';
import platformRoutes from './routes/platform.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://clinic-frontend-demo.vercel.app',
  ...(process.env.CORS_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean)
]);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    try {
      const { protocol, hostname } = new URL(origin);
      const preview = protocol === 'https:' && hostname.endsWith('.vercel.app') && hostname.startsWith('clinic-frontend-demo');
      return callback(null, preview);
    } catch {
      return callback(null, false);
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '4mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'linden' });
});

app.use('/api', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api', clinicalRoutes);
app.use('/api', operationsRoutes);
app.use('/api', platformRoutes);

app.use((error, _req, res, _next) => {
  const status = error.status || (error.code === '23505' ? 409 : error.code === '23503' ? 400 : 500);
  if (status >= 500) console.error(error);
  const message = status === 409
    ? 'That record already exists.'
    : status >= 500
      ? 'Something went wrong while saving that change.'
      : error.message;
  res.status(status).json({ error: message, ...(error instanceof HttpError ? error.extra : {}) });
});

const port = Number(process.env.PORT || 4000);

assertDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Linden API listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Database connection failed.', error.message);
    process.exit(1);
  });
