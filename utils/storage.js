const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_DB_PATH = path.join(__dirname, "..", "data", "web2knowledge.sqlite");

let db;

function getDatabasePath() {
  return process.env.KB_DB_PATH || DEFAULT_DB_PATH;
}

function getDatabase() {
  if (db) return db;

  const dbPath = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      chunkIndex INTEGER NOT NULL,
      generatedJson TEXT
    )
  `);

  return db;
}

function loadChunks() {
  const rows = getDatabase()
    .prepare(
      `SELECT id, title, source, content, chunkIndex, generatedJson
       FROM chunks
       ORDER BY rowid ASC`
    )
    .all();

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    source: row.source,
    content: row.content,
    chunkIndex: row.chunkIndex,
    ...(row.generatedJson ? { generatedJson: JSON.parse(row.generatedJson) } : {}),
  }));
}

function saveChunks(chunks) {
  const database = getDatabase();
  const insert = database.prepare(`
    INSERT INTO chunks (id, title, source, content, chunkIndex, generatedJson)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  database.exec("DELETE FROM chunks");

  database.exec("BEGIN");

  try {
    (Array.isArray(chunks) ? chunks : []).forEach((chunk) => {
      insert.run(
        chunk.id,
        chunk.title,
        chunk.source,
        chunk.content,
        Number(chunk.chunkIndex) || 0,
        chunk.generatedJson ? JSON.stringify(chunk.generatedJson) : null
      );
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function clearChunks() {
  getDatabase().exec("DELETE FROM chunks");
}

function closeDatabaseForTest() {
  if (!db) return;
  db.close();
  db = null;
}

module.exports = {
  clearChunks,
  closeDatabaseForTest,
  loadChunks,
  saveChunks,
};
