import { readdirSync } from "node:fs";
import { join } from "node:path";

const ignored = new Set([
  ".git",
  ".desktop-build",
  "node_modules",
  "data",
  "dist",
  ".browsers",
  ".venv",
  "coverage",
  "__pycache__",
  ".ruff_cache",
]);
const textFiles = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
  ".env.example",
]);

// Walk source files directly so untracked or accidentally Git-ignored source is checked too.
export function repositoryFiles(root: string, directory = ""): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      if (
        ignored.has(entry.name) ||
        entry.isSymbolicLink() ||
        (directory === "src-tauri" &&
          ["resources", "gen", "target"].includes(entry.name))
      )
        return [];
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return repositoryFiles(root, path);
      return entry.isFile() &&
        (textFiles.has(entry.name) ||
          /\.(?:[cm]?[jt]sx?|jsonc?|css|html|md|ya?ml|toml|py|svg|rs|plist)$/.test(
            entry.name,
          ))
        ? [path]
        : [];
    })
    .sort();
}
