import { resolve } from "node:path";
export const config = {
  port: Number(process.env.PORT || 3210),
  dataDir: resolve(process.env.DATA_DIR || "./data"),
  ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  model: process.env.OLLAMA_MODEL || "gemma4:12b-mlx",
  context: Number(process.env.OLLAMA_CONTEXT || 16384),
  tagHours: Number(process.env.TAG_REVIEW_HOURS || 24),
  backupHours: Number(process.env.BACKUP_HOURS || 24),
};
