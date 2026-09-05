import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 });
const q = process.argv[2];
const rows = await sql.unsafe(q);
console.log(JSON.stringify(rows, null, 1));
await sql.end();
