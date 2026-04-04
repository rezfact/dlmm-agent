/**
 * Persistent data directory for state JSON, logs, and user-config.
 * Set MERIDIAN_DATA_DIR (e.g. /data in Docker) to store data on a volume.
 * Default: process.cwd() (unchanged behavior when unset).
 */
import fs from "fs";
import path from "path";

export function getDataDir() {
  const d = process.env.MERIDIAN_DATA_DIR?.trim();
  if (d) return path.resolve(d);
  return process.cwd();
}

export function dataPath(...parts) {
  return path.join(getDataDir(), ...parts);
}

const _dir = process.env.MERIDIAN_DATA_DIR?.trim();
if (_dir) {
  const resolved = path.resolve(_dir);
  if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
}
