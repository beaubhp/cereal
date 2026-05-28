import type BetterSqlite3 from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'

export type SqliteDatabase = BetterSqlite3.Database
type DatabaseConstructor = typeof BetterSqlite3

let defaultDatabase: SqliteDatabase | null = null
let databaseConstructor: DatabaseConstructor | null = null
const nodeRequire = createRequire(import.meta.url)

export function getDefaultDatabasePath(): string {
  const electron = nodeRequire('electron') as typeof import('electron')
  if (!electron.app) {
    throw new Error('Electron app is unavailable; pass an explicit database path instead')
  }

  return join(electron.app.getPath('userData'), 'data.sqlite')
}

export function openDatabase(databasePath = getDefaultDatabasePath()): SqliteDatabase {
  ensureDatabaseDirectory(databasePath)

  const Database = loadDatabaseConstructor()
  const db = new Database(databasePath)
  applyPragmas(db)
  migrateDatabase(db)
  return db
}

export function getDatabase(): SqliteDatabase {
  if (!defaultDatabase) {
    defaultDatabase = openDatabase()
  }

  return defaultDatabase
}

export function closeDatabase(): void {
  if (!defaultDatabase) {
    return
  }

  defaultDatabase.close()
  defaultDatabase = null
}

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ':memory:' || databasePath.startsWith('file:')) {
    return
  }

  const directory = dirname(databasePath)
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true })
  }
}

function loadDatabaseConstructor(): DatabaseConstructor {
  if (databaseConstructor) {
    return databaseConstructor
  }

  const loaded = nodeRequire(getBetterSqlite3ModulePath()) as
    | DatabaseConstructor
    | { default?: DatabaseConstructor }
  const candidate = typeof loaded === 'function' ? loaded : loaded.default
  if (typeof candidate !== 'function') {
    throw new Error('Failed to load better-sqlite3 constructor')
  }

  databaseConstructor = candidate
  return databaseConstructor
}

function getBetterSqlite3ModulePath(): string {
  if (!process.versions.electron) {
    return 'better-sqlite3'
  }

  const electron = nodeRequire('electron') as typeof import('electron')
  if (electron.app?.isPackaged) {
    return join(process.resourcesPath, 'electron-native', 'node_modules', 'better-sqlite3')
  }

  return join(electron.app.getAppPath(), '.electron-native', 'node_modules', 'better-sqlite3')
}

function applyPragmas(db: SqliteDatabase): void {
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  if (db.name !== ':memory:') {
    db.pragma('journal_mode = WAL')
  }
}

export function migrateDatabase(db: SqliteDatabase): void {
  const currentVersion = getUserVersion(db)

  if (currentVersion > 1) {
    throw new Error(`Unsupported database schema version: ${currentVersion}`)
  }

  if (currentVersion < 1) {
    db.transaction(() => {
      db.exec(INITIAL_SCHEMA)
      db.pragma('user_version = 1')
    })()
  }
}

function getUserVersion(db: SqliteDatabase): number {
  const row = db.pragma('user_version', { simple: true })
  return typeof row === 'number' ? row : Number(row)
}

const INITIAL_SCHEMA = `
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds INTEGER,
  detected_app TEXT,
  detected_app_bundle_id TEXT,
  template TEXT NOT NULL DEFAULT 'general',
  created_at TEXT NOT NULL
);

CREATE INDEX meetings_started_at_idx ON meetings(started_at DESC);

CREATE TABLE transcript_segments (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  speaker TEXT NOT NULL,
  speaker_label TEXT,
  text TEXT NOT NULL,
  start_time_ms INTEGER NOT NULL,
  end_time_ms INTEGER NOT NULL,
  is_me INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE INDEX transcript_segments_meeting_time_idx
  ON transcript_segments(meeting_id, start_time_ms);

CREATE INDEX transcript_segments_meeting_speaker_idx
  ON transcript_segments(meeting_id, speaker);

CREATE TABLE meeting_notes (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL UNIQUE,
  summary TEXT,
  action_items TEXT NOT NULL DEFAULT '[]',
  key_decisions TEXT NOT NULL DEFAULT '[]',
  key_quotes TEXT NOT NULL DEFAULT '[]',
  raw_llm_output TEXT,
  template_used TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE transcript_fts USING fts5(
  text,
  content='transcript_segments',
  content_rowid='rowid'
);

CREATE TRIGGER transcript_ai AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO transcript_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER transcript_ad AFTER DELETE ON transcript_segments BEGIN
  INSERT INTO transcript_fts(transcript_fts, rowid, text)
  VALUES('delete', old.rowid, old.text);
END;

CREATE TRIGGER transcript_au AFTER UPDATE ON transcript_segments BEGIN
  INSERT INTO transcript_fts(transcript_fts, rowid, text)
  VALUES('delete', old.rowid, old.text);
  INSERT INTO transcript_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  summary,
  action_items,
  key_decisions,
  key_quotes,
  content='meeting_notes',
  content_rowid='rowid'
);

CREATE TRIGGER notes_ai AFTER INSERT ON meeting_notes BEGIN
  INSERT INTO notes_fts(rowid, summary, action_items, key_decisions, key_quotes)
  VALUES (new.rowid, new.summary, new.action_items, new.key_decisions, new.key_quotes);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON meeting_notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, summary, action_items, key_decisions, key_quotes)
  VALUES('delete', old.rowid, old.summary, old.action_items, old.key_decisions, old.key_quotes);
END;

CREATE TRIGGER notes_au AFTER UPDATE ON meeting_notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, summary, action_items, key_decisions, key_quotes)
  VALUES('delete', old.rowid, old.summary, old.action_items, old.key_decisions, old.key_quotes);
  INSERT INTO notes_fts(rowid, summary, action_items, key_decisions, key_quotes)
  VALUES (new.rowid, new.summary, new.action_items, new.key_decisions, new.key_quotes);
END;
`
