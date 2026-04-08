const fs = require("fs").promises;
const path = require("path");

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");

/**
 * readJson(filename)
 * Reads a JSON file from the data directory.
 * Returns empty default structure if file doesn't exist.
 */
async function readJson(filename) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    const raw = await fs.readFile(filepath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      // Return sensible defaults for each known file
      return getDefaultStructure(filename);
    }
    throw err;
  }
}

/**
 * writeJson(filename, data)
 * Writes data to a JSON file in the data directory.
 * Creates the directory if it doesn't exist.
 */
async function writeJson(filename, data) {
  const filepath = path.join(DATA_DIR, filename);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(filepath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * getDefaultStructure(filename)
 * Returns an empty but valid default for each data file.
 */
function getDefaultStructure(filename) {
  const defaults = {
    "memory.json": { entries: [] },
    "projects.json": { projects: [] },
    "people.json": { people: [] },
    "sessionContext.json": { history: [] },
    "pendingInquiry.json": null,
    "watcherState.json": { notified: {}, lastRun: null },
    "usage.json": { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, by_model: {}, updated_at: null },
  };
  return defaults[filename] ?? {};
}

module.exports = { readJson, writeJson };
