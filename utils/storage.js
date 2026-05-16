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
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      input TEXT,
      mode TEXT,
      researchMode TEXT,
      extractionMode TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      totalSources INTEGER NOT NULL DEFAULT 0,
      totalChunks INTEGER NOT NULL DEFAULT 0,
      sourcesJson TEXT,
      summary TEXT,
      active INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      projectId TEXT,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      chunkIndex INTEGER NOT NULL,
      generatedJson TEXT,
      FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);

  migrateExistingChunks(db);

  return db;
}

function migrateExistingChunks(database) {
  const columns = database.prepare("PRAGMA table_info(chunks)").all();
  const hasProjectId = columns.some((column) => column.name === "projectId");

  if (!hasProjectId) {
    database.exec("ALTER TABLE chunks ADD COLUMN projectId TEXT");
  }

  const orphanCount = database
    .prepare("SELECT COUNT(*) AS count FROM chunks WHERE projectId IS NULL")
    .get().count;

  if (orphanCount === 0) return;

  const project = createProjectRecord({
    id: `project-${Date.now()}`,
    name: "Imported Dataset",
    input: "",
    mode: "imported",
    researchMode: "",
    extractionMode: "",
    totalChunks: orphanCount,
    active: 1,
  });

  database.prepare("UPDATE chunks SET projectId = ? WHERE projectId IS NULL").run(project.id);
}

function createProjectRecord(metadata = {}) {
  const database = getDatabase();
  const now = new Date().toISOString();
  const project = {
    id: metadata.id || `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: metadata.name || "Untitled Dataset",
    input: metadata.input || "",
    mode: metadata.mode || "",
    researchMode: metadata.researchMode || "",
    extractionMode: metadata.extractionMode || "",
    createdAt: metadata.createdAt || now,
    updatedAt: metadata.updatedAt || now,
    totalSources: Number(metadata.totalSources) || 0,
    totalChunks: Number(metadata.totalChunks) || 0,
    sourcesJson: metadata.sources ? JSON.stringify(metadata.sources) : metadata.sourcesJson || null,
    summary: metadata.summary || "",
    active: metadata.active ? 1 : 0,
  };

  if (project.active) {
    database.exec("UPDATE projects SET active = 0");
  }

  database
    .prepare(`
      INSERT INTO projects (
        id, name, input, mode, researchMode, extractionMode, createdAt, updatedAt,
        totalSources, totalChunks, sourcesJson, summary, active
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      project.id,
      project.name,
      project.input,
      project.mode,
      project.researchMode,
      project.extractionMode,
      project.createdAt,
      project.updatedAt,
      project.totalSources,
      project.totalChunks,
      project.sourcesJson,
      project.summary,
      project.active
    );

  return project;
}

function createProject(metadata = {}) {
  return createProjectRecord({
    ...metadata,
    active: true,
  });
}

function getActiveProject() {
  return getDatabase()
    .prepare("SELECT * FROM projects WHERE active = 1 ORDER BY updatedAt DESC LIMIT 1")
    .get() || null;
}

function parseProject(row) {
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    input: row.input,
    mode: row.mode,
    researchMode: row.researchMode,
    extractionMode: row.extractionMode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    totalSources: row.totalSources,
    totalChunks: row.totalChunks,
    sources: row.sourcesJson ? JSON.parse(row.sourcesJson) : [],
    summary: row.summary || "",
    active: Boolean(row.active),
  };
}

function listProjects() {
  return getDatabase()
    .prepare(`
      SELECT * FROM projects
      ORDER BY active DESC, updatedAt DESC
    `)
    .all()
    .map(parseProject);
}

function activateProject(projectId) {
  const database = getDatabase();
  const project = database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);

  if (!project) {
    const error = new Error("Project not found.");
    error.statusCode = 404;
    throw error;
  }

  database.exec("UPDATE projects SET active = 0");
  database.prepare("UPDATE projects SET active = 1, updatedAt = ? WHERE id = ?").run(
    new Date().toISOString(),
    projectId
  );

  return parseProject(database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId));
}

function deleteActiveProject() {
  const database = getDatabase();
  const project = getActiveProject();

  if (!project) return;

  database.prepare("DELETE FROM chunks WHERE projectId = ?").run(project.id);
  database.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
}

function loadChunks(projectId) {
  const project = projectId
    ? { id: projectId }
    : getActiveProject();

  if (!project) return [];

  const rows = getDatabase()
    .prepare(
      `SELECT id, projectId, title, source, content, chunkIndex, generatedJson
       FROM chunks
       WHERE projectId = ?
       ORDER BY rowid ASC`
    )
    .all(project.id);

  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    source: row.source,
    content: row.content,
    chunkIndex: row.chunkIndex,
    ...(row.generatedJson ? { generatedJson: JSON.parse(row.generatedJson) } : {}),
  }));
}

function saveChunks(chunks, metadata = {}) {
  const database = getDatabase();
  let project = getActiveProject();

  if (!project) {
    project = createProject({
      name: metadata.name || "Untitled Dataset",
      input: metadata.input || "",
      mode: metadata.mode || "",
      researchMode: metadata.researchMode || "",
      extractionMode: metadata.extractionMode || "",
    });
  }

  const projectId = metadata.projectId || project.id;
  const insert = database.prepare(`
    INSERT INTO chunks (id, projectId, title, source, content, chunkIndex, generatedJson)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  database.prepare("DELETE FROM chunks WHERE projectId = ?").run(projectId);
  database.exec("BEGIN");

  try {
    (Array.isArray(chunks) ? chunks : []).forEach((chunk) => {
      insert.run(
        chunk.id,
        projectId,
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

  updateProjectMetadata(projectId, {
    ...metadata,
    totalChunks: Array.isArray(chunks) ? chunks.length : 0,
  });
}

function updateProjectMetadata(projectId, metadata = {}) {
  const project = getDatabase().prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  if (!project) return;

  const next = {
    name: metadata.name || project.name,
    input: metadata.input ?? project.input,
    mode: metadata.mode ?? project.mode,
    researchMode: metadata.researchMode ?? project.researchMode,
    extractionMode: metadata.extractionMode ?? project.extractionMode,
    totalSources: metadata.totalSources ?? project.totalSources,
    totalChunks: metadata.totalChunks ?? project.totalChunks,
    sourcesJson: metadata.sources ? JSON.stringify(metadata.sources) : metadata.sourcesJson ?? project.sourcesJson,
    summary: metadata.summary ?? project.summary,
    updatedAt: new Date().toISOString(),
  };

  getDatabase()
    .prepare(`
      UPDATE projects
      SET name = ?, input = ?, mode = ?, researchMode = ?, extractionMode = ?,
          totalSources = ?, totalChunks = ?, sourcesJson = ?, summary = ?, updatedAt = ?
      WHERE id = ?
    `)
    .run(
      next.name,
      next.input,
      next.mode,
      next.researchMode,
      next.extractionMode,
      next.totalSources,
      next.totalChunks,
      next.sourcesJson,
      next.summary,
      next.updatedAt,
      projectId
    );
}

function clearChunks() {
  deleteActiveProject();
}

function closeDatabaseForTest() {
  if (!db) return;
  db.close();
  db = null;
}

module.exports = {
  activateProject,
  clearChunks,
  closeDatabaseForTest,
  createProject,
  getActiveProject: () => parseProject(getActiveProject()),
  listProjects,
  loadChunks,
  saveChunks,
  updateProjectMetadata,
};
