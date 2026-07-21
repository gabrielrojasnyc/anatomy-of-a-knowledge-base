import pg from "pg";

/**
 * Vitest globalSetup: runs once, before any test file, in the main process.
 * Ensures the isolated kb_test database exists so the suite never touches
 * the live kb database (which holds real distilled content).
 */
export default async function setup(): Promise<void> {
  const client = new pg.Client({
    connectionString: "postgres://kb:kb@localhost:5433/kb",
  });
  await client.connect();
  try {
    await client.query("CREATE DATABASE kb_test");
  } catch (e) {
    const err = e as { code?: string };
    if (err.code !== "42P04") throw e; // duplicate_database: kb_test already exists
  } finally {
    await client.end();
  }
}
