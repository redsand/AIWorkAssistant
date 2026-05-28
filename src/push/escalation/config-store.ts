import Database from "better-sqlite3";
import path from "path";

export interface EscalationSourceConfig {
  source: "hawk-ir" | "jitbit";
  enabled: boolean;
}

export interface EscalationRuntimeConfig {
  globalEnabled: boolean;
  sources: EscalationSourceConfig[];
}

const DB_PATH = path.join(process.cwd(), "data", "app.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS escalation_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

const stmtGet = db.prepare("SELECT value FROM escalation_config WHERE key = ?");
const stmtSet = db.prepare("INSERT OR REPLACE INTO escalation_config (key, value) VALUES (?, ?)");

function getBool(key: string, defaultVal: boolean): boolean {
  const row = stmtGet.get(key) as { value: string } | undefined;
  return row ? row.value === "1" : defaultVal;
}

function setBool(key: string, val: boolean): void {
  stmtSet.run(key, val ? "1" : "0");
}

export function getEscalationConfig(): EscalationRuntimeConfig {
  return {
    globalEnabled: getBool("global_enabled", true),
    sources: [
      { source: "hawk-ir", enabled: getBool("source_hawk-ir", true) },
      { source: "jitbit", enabled: getBool("source_jitbit", true) },
    ],
  };
}

export function setEscalationConfig(config: Partial<EscalationRuntimeConfig>): void {
  if (config.globalEnabled !== undefined) {
    setBool("global_enabled", config.globalEnabled);
  }
  if (config.sources) {
    for (const s of config.sources) {
      setBool(`source_${s.source}`, s.enabled);
    }
  }
}

export function isSourceEscalationEnabled(source: string): boolean {
  const cfg = getEscalationConfig();
  if (!cfg.globalEnabled) return false;
  const src = cfg.sources.find((s) => s.source === source);
  return src?.enabled ?? true;
}
