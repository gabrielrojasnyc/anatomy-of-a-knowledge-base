import pg from "pg";
import { loadConfig } from "./config.js";

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: loadConfig().databaseUrl, max: 10 });
  return pool;
}
