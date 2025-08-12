// tools/import_questions.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATABASE_URL = process.env.DATABASE_URL || "";
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL nincs beállítva.");
  process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function ensureSchema() {
  await pool.query(`
    create table if not exists questions (
      id serial primary key,
      category text not null,
      question text not null,
      correct text not null
    );
    create table if not exists wrong_answers (
      id serial primary key,
      question_id int not null references questions(id) on delete cascade,
      text text not null
    );
    create index if not exists idx_wrong_answers_qid on wrong_answers(question_id);
  `);
}

async function run() {
  await ensureSchema();

  const jsonPath = path.join(path.dirname(__dirname), "questions.json");
  const raw = fs.readFileSync(jsonPath, "utf8");
  const items = JSON.parse(raw);

  console.log(`📥 ${items.length} kérdés importálása…`);

  // truncate előtt kérdezz rá, de most MVP-ben ürítjük és újratöltjük
  await pool.query("truncate wrong_answers restart identity cascade;");
  await pool.query("truncate questions restart identity cascade;");

  for (const q of items) {
    const wrong = Array.isArray(q.wrong) ? q.wrong : (q.wrongAnswers || []);
    const insQ = await pool.query(
      "insert into questions(category, question, correct) values ($1,$2,$3) returning id",
      [q.category, q.question, q.correct]
    );
    const qid = insQ.rows[0].id;
    if (wrong.length) {
      const values = wrong.flatMap(w => [qid, w]);
      const params = wrong.map((_, i) => `($${2*i+1}, $${2*i+2})`).join(",");
      await pool.query(`insert into wrong_answers(question_id, text) values ${params}`, values);
    }
  }

  console.log("✅ Kész.");
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
