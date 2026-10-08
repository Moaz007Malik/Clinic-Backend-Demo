import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const ssl = { rejectUnauthorized: false };
const POOLER_HOST = 'aws-0-ap-southeast-2.pooler.supabase.com';

function connectionStringFor(connectionString) {
  if (!connectionString) return connectionString;
  const url = new URL(connectionString);
  const match = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (!match) return connectionString;
  const ref = match[1];
  if (!url.username.includes('.')) url.username = `${url.username}.${ref}`;
  url.hostname = POOLER_HOST;
  url.port = '5432';
  return url.toString();
}

const warmed = new WeakSet();

function makePool(connectionString) {
  return new pg.Pool({
    connectionString: connectionStringFor(connectionString),
    ssl,
    max: 5,
    idleTimeoutMillis: 180000,
    connectionTimeoutMillis: 10000,
    keepAlive: true
  });
}

async function warm(client) {
  if (warmed.has(client)) return;
  await client.query(`SELECT set_config('search_path', 'atrium, public', false), set_config('statement_timeout', '8000', false)`);
  warmed.add(client);
}

export const adminPool = makePool(process.env.DATABASE_URL);

function appConnectionString() {
  const url = new URL(process.env.DATABASE_URL);
  url.username = 'atrium_app';
  url.password = process.env.APP_ROLE_PASSWORD || '';
  return url.toString();
}

export const appPool = makePool(appConnectionString());

let useAppRole = true;

export function setUseAppRole(value) {
  useAppRole = value;
}

export async function adminQuery(text, params) {
  const client = await adminPool.connect();
  try {
    await warm(client);
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function applyTenant(client, req) {
  await client.query(
    `SELECT set_config('app.is_super', $1, false), set_config('app.organization_id', $2, false), set_config('app.user_id', $3, false)`,
    [req?.user?.isSuper ? 'true' : 'false', req?.user?.organizationId || '', req?.user?.id || '']
  );
}

async function withContext(pool, req, fn, transactional) {
  const client = await pool.connect();
  try {
    await warm(client);
    if (transactional) await client.query('BEGIN');
    if (useAppRole) await applyTenant(client, req);
    const result = await fn(client);
    if (transactional) await client.query('COMMIT');
    return result;
  } catch (error) {
    if (transactional) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection already closed */
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function requestPool() {
  return useAppRole ? appPool : adminPool;
}

export function q(req, text, params = []) {
  return withContext(requestPool(), req, (client) => client.query(text, params), false);
}

export function tx(req, fn) {
  return withContext(requestPool(), req, fn, true);
}

export async function adminTx(fn) {
  const client = await adminPool.connect();
  try {
    await warm(client);
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function assertDatabase() {
  const client = await adminPool.connect();
  try {
    await warm(client);
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
  try {
    await appPool.query('SELECT 1');
    useAppRole = true;
  } catch (error) {
    useAppRole = false;
    console.warn(`App role unavailable (${error.message}). Tenant filters still run in the API.`);
  }
}
