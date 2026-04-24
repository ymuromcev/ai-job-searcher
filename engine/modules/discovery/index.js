// Auto-registry of discovery adapters.
// Loads every `*.js` sibling except files starting with `_` and `*.test.js`.
// Each adapter MUST export:
//   - source: string (unique, lowercase id)
//   - discover(targets, ctx): Promise<NormalizedJob[]>
//
// Usage:
//   const { listAdapters, getAdapter } = require('./index.js');

const fs = require("fs");
const path = require("path");

const ADAPTERS_DIR = __dirname;
const SELF = path.basename(__filename);

function isAdapterFile(name) {
  if (!name.endsWith(".js")) return false;
  if (name === SELF) return false;
  if (name.startsWith("_")) return false;
  if (name.endsWith(".test.js")) return false;
  return true;
}

function assertAdapterShape(mod, file) {
  if (!mod || typeof mod !== "object") {
    throw new Error(`adapter ${file} must export an object`);
  }
  if (typeof mod.source !== "string" || !mod.source) {
    throw new Error(`adapter ${file} must export non-empty "source" string`);
  }
  if (typeof mod.discover !== "function") {
    throw new Error(`adapter ${file} must export "discover" function`);
  }
}

function buildRegistry(dir = ADAPTERS_DIR) {
  const registry = new Map();
  const files = fs.readdirSync(dir).filter(isAdapterFile).sort();
  for (const file of files) {
    const mod = require(path.join(dir, file));
    assertAdapterShape(mod, file);
    if (registry.has(mod.source)) {
      throw new Error(
        `duplicate adapter source "${mod.source}" (file ${file} collides with existing)`
      );
    }
    registry.set(mod.source, mod);
  }
  return registry;
}

let cached = null;

function getRegistry() {
  if (!cached) cached = buildRegistry();
  return cached;
}

function resetRegistry() {
  cached = null;
}

function listAdapters() {
  return Array.from(getRegistry().keys()).sort();
}

function getAdapter(source) {
  const reg = getRegistry();
  if (!reg.has(source)) {
    throw new Error(`unknown adapter: ${source}. Known: ${listAdapters().join(", ") || "(none)"}`);
  }
  return reg.get(source);
}

module.exports = { listAdapters, getAdapter, resetRegistry, buildRegistry };
