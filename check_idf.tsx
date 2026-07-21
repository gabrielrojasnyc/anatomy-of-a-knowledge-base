import pg from "pg";

const pool = new pg.Pool();

const query = "what is HELIOS_PREFETCH_DEPTH";
const tokens = [...new Set(query.toLowerCase().split(/\W+/).filter(t => t.length > 0))];

console.log("Tokens in query:", tokens);

const { rows } = await pool.query(
  `SELECT token, idf FROM token_idf WHERE token = ANY($1) ORDER BY idf DESC`,
  [tokens]
);

console.log("\nToken IDFs:");
rows.forEach((r: any) => console.log(`  ${r.token}: ${r.idf}`));

console.log("\nTokens with IDF >= 3.5:");
rows.filter((r: any) => r.idf >= 3.5).forEach((r: any) => console.log(`  ${r.token}: ${r.idf}`));

console.log("\nTokens with IDF between 2.5 and 3.5:");
rows.filter((r: any) => r.idf >= 2.5 && r.idf < 3.5).forEach((r: any) => console.log(`  ${r.token}: ${r.idf}`));

await pool.end();
