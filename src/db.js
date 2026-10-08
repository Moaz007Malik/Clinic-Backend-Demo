import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const ssl = { rejectUnauthorized: false };

function makePool(connectionString) {
  const pool = new pg.Pool({ connectionString, ssl, max: 8, idleTimeoutMillis: 20000 });
  return pool;
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
    await client.query('SET search_path TO atrium, public');
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function withContext(pool, req, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('search_path', 'atrium, public', true)`);
    await client.query(`SELECT set_config('statement_timeout', '20000', true)`);
    await client.query(`SELECT set_config('app.is_super', $1, true)`, [req?.user?.isSuper ? 'true' : 'false']);
    await client.query(`SELECT set_config('app.organization_id', $1, true)`, [req?.user?.organizationId || '']);
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [req?.user?.id || '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already closed */
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
  return withContext(requestPool(), req, (client) => client.query(text, params));
}

export function tx(req, fn) {
  return withContext(requestPool(), req, fn);
}

export async function adminTx(fn) {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET search_path TO atrium, public');
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
    await client.query('SET search_path TO atrium, public');
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
