import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Web + worker each hold their own pool. A single dashboard mount fans out
  // several parallel API calls (each with a session lookup), and quotas/usage
  // alone runs ~19 queries — 10 connections starved under modest concurrency.
  // Postgres default max_connections=100 comfortably fits 25×2 + psql slack.
  max: Number(process.env.DB_POOL_MAX || 25),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool, { schema });
export type Database = typeof db;
export { schema };
