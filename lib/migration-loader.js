// ============================================================
// Quanto · bundled SQL migration loader
// ============================================================
// Reads the SQL migrations shipped inside the app package
// (db/migrations/NNNN_name.sql) and returns them sorted by id,
// ready for lib/db-migrator.js to apply against D1. This is the
// only cloud module that touches the filesystem (one place per
// concern — ARCHITECTURE.md §3); main-process only.
// ============================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadMigrations(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    throw new Error('No se encontró la carpeta de migraciones: ' + dir, { cause: err });
  }
  return files
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => {
      let sql;
      try {
        sql = fs.readFileSync(path.join(dir, f), 'utf8');
      } catch (err) {
        throw new Error('No se pudo leer la migración: ' + f, { cause: err });
      }
      return { id: f.replace(/\.sql$/, ''), sql };
    });
}

module.exports = { loadMigrations };
