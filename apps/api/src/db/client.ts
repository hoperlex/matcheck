import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadEnv } from '../lib/env.js';
import * as schema from './schema.js';

const env = loadEnv();

const connectionString = env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/matcheck';

export const sql = postgres(connectionString, {
  max: 10,
  idle_timeout: 30,
  prepare: false,
});

export const db = drizzle(sql, { schema, casing: 'snake_case' });

export type Db = typeof db;
export { schema };
