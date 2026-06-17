// ============================================================
// Tests · backend write/conflict contract (file + d1)
// ============================================================
// A shared suite (PRD R18) run against BOTH storage backends:
//   - file: lib/config-store.js on a real tmpdir
//   - d1:   lib/catalog-writer.js writeEntities + a fake client
// Each backend is wrapped in a tiny adapter exposing the same two
// operations the contract cares about:
//   loadBaseline()            → an opaque baseline token (versions/hash)
//   save(baseline, mutate)    → { ok, conflict } applying `mutate(cfg)`
//
// The guarantees asserted for every backend:
//   (a) a write from the current baseline SUCCEEDS;
//   (b) a write from a STALE baseline is reported as a conflict —
//       never a silent overwrite.
// ============================================================
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getFileInfo,
  writeConfigAtomic,
  readConfigFromFile
} from '../lib/config-store.js';
import { extractJsonFromConfig } from '../lib/config-parser.js';
import { writeEntities } from '../lib/catalog-writer.js';
import { buildFullConfigV4 as buildDefaultConfig } from './fixtures/config-v4-full.js';

const NOW = () => '2026-06-13T12:00:00.000Z';

function cleanCfg() {
  const cfg = buildDefaultConfig();
  delete cfg.admin;
  return cfg;
}

// ------------------------------------------------------------
// File backend adapter (lib/config-store.js)
// ------------------------------------------------------------
// The conflict contract for the file backend: getFileInfo() captures
// the hash the caller read; on save the caller re-reads getFileInfo()
// and refuses the write when the hash moved (mirrors main.js
// config:write). config-store provides the primitives; this adapter is
// the same guard main.js applies.
function makeFileBackend(tmpDir) {
  const filePath = path.join(tmpDir, 'config.js');
  // Seed an initial config file (file mode keeps the admin section).
  writeConfigAtomic(filePath, buildDefaultConfig({ modified_by: 'seed' }));

  return {
    loadBaseline() {
      const cfg = readConfigFromFile(filePath);
      return { cfg, info: getFileInfo(filePath) };
    },
    save(baseline, mutate) {
      const current = getFileInfo(filePath);
      // Conflict: the file moved since the baseline was read.
      if (baseline.info && current && current.hash !== baseline.info.hash) {
        return { ok: false, conflict: true };
      }
      const next = JSON.parse(JSON.stringify(baseline.cfg));
      mutate(next);
      next.modified_by = 'tester';
      writeConfigAtomic(filePath, next);
      return { ok: true, conflict: false };
    },
    // Used by the test to simulate a competing writer between read and save.
    externalWrite(mutate) {
      const cfg = readConfigFromFile(filePath);
      mutate(cfg);
      cfg.modified_by = 'other-pc';
      writeConfigAtomic(filePath, cfg);
    },
    readName() {
      return extractJsonFromConfig(fs.readFileSync(filePath, 'utf-8')).company.name;
    }
  };
}

// ------------------------------------------------------------
// D1 backend adapter (lib/catalog-writer.js)
// ------------------------------------------------------------
// A fake D1 world holding the company.name row + entity versions +
// catalog_version, so a real writeEntities call exercises the guard.
function makeD1Backend() {
  const state = {
    catalogVersion: 7,
    productVersion: { BEAGLE: 1, CLASICA: 1, URBAN: 1 },
    companyName: cleanCfg().company.name
  };
  const client = {
    state,
    async query(sql, params = []) {
      // Guarded UPDATE of a product main row.
      const guard = sql.match(/^UPDATE products SET version = version \+ 1.*WHERE id = \? AND version = \?$/);
      if (guard) {
        const [, id, expected] = params;
        if (state.productVersion[id] === expected) {
          state.productVersion[id] += 1;
          return { results: [], meta: { changes: 1 } };
        }
        return { results: [], meta: { changes: 0 } }; // stale → conflict
      }
      if (/^SELECT \* FROM products WHERE id = \?/.test(sql)) {
        const id = params[0];
        return { results: [{ id, version: state.productVersion[id] }], meta: {} };
      }
      if (/^UPDATE catalog_meta SET catalog_version/.test(sql)) {
        state.catalogVersion = params[0];
        return { results: [], meta: { changes: 1 } };
      }
      // DELETE/INSERT children, audit, snapshot: accepted.
      return { results: [], meta: { changes: 1 } };
    }
  };

  function baselineVersions() {
    return {
      catalogVersion: state.catalogVersion,
      pack: {}, supplier: {}, addon: {},
      product: { ...state.productVersion }
    };
  }

  return {
    loadBaseline() {
      return { cfg: cleanCfg(), expectedVersions: baselineVersions() };
    },
    save(baseline, mutate) {
      const next = JSON.parse(JSON.stringify(baseline.cfg));
      mutate(next);
      return writeEntities(client, {
        oldCfg: baseline.cfg, newCfg: next,
        user: 'tester', now: NOW,
        expectedVersions: baseline.expectedVersions
      }).then((res) => ({ ok: res.ok, conflict: res.conflicts.length > 0 }));
    },
    // Simulate a competing writer: bump the product version server-side.
    externalWrite() {
      state.productVersion.BEAGLE += 1;
    }
  };
}

// ------------------------------------------------------------
// Shared contract
// ------------------------------------------------------------
let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packprice-contract-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const BACKENDS = {
  file: () => makeFileBackend(tmpDir),
  d1: () => makeD1Backend()
};

for (const [name, factory] of Object.entries(BACKENDS)) {
  describe(`backend contract · ${name}`, () => {
    test('a write from the current baseline succeeds', async () => {
      const backend = factory();
      const baseline = backend.loadBaseline();
      const res = await backend.save(baseline, (cfg) => {
        cfg.products.BEAGLE.name = 'Camiseta contractual';
      });
      expect(res.ok).toBe(true);
      expect(res.conflict).toBe(false);
    });

    test('a stale-baseline write is reported as a conflict, never a silent overwrite', async () => {
      const backend = factory();
      const baseline = backend.loadBaseline();
      // Another writer changes the SAME entity after our baseline read.
      backend.externalWrite((cfg) => { cfg.products.BEAGLE.name = 'Editado por otro'; });
      const res = await backend.save(baseline, (cfg) => {
        cfg.products.BEAGLE.name = 'Mi edición';
      });
      expect(res.ok).toBe(false);
      expect(res.conflict).toBe(true);
    });
  });
}
