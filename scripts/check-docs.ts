import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import GitHubSlugger from "github-slugger";
import { Window } from "happy-dom";
import { repositoryFiles } from "./checks/files";

type Node = {
  type: string;
  value?: string;
  url?: string;
  lang?: string | null;
  children?: Node[];
  position?: { start: { line: number } };
};
function nodes(node: Node): Node[] {
  return [node, ...(node.children?.flatMap(nodes) || [])];
}
function textContent(node: Node): string {
  return node.value || node.children?.map(textContent).join("") || "";
}

export async function checkDocumentation(root: string) {
  const issues: string[] = [];
  const files = repositoryFiles(root).filter((file) => file.endsWith(".md"));
  const trees = new Map(
    files.map((file) => [
      file,
      fromMarkdown(readFileSync(resolve(root, file), "utf8")),
    ]),
  );
  const anchors = new Map<string, Set<string>>();
  for (const [file, tree] of trees) {
    const slugger = new GitHubSlugger();
    anchors.set(
      file,
      new Set(
        nodes(tree)
          .filter((node) => node.type === "heading")
          .map((node) => slugger.slug(textContent(node))),
      ),
    );
  }
  // A DOM implementation is needed by Mermaid's sanitizer, not for browser rendering.
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
    },
  });
  Object.assign(globalThis, { window, document: window.document });
  const { default: mermaid } = await import("mermaid");
  let diagrams = 0;
  for (const [file, tree] of trees) {
    for (const node of nodes(tree)) {
      const location = `${file}:${node.position?.start.line || 1}`;
      if (node.url && ["link", "image", "definition"].includes(node.type)) {
        if (/^(?:https?:|mailto:)/i.test(node.url)) continue;
        try {
          if (/^[a-z][a-z\d+.-]*:/i.test(node.url))
            throw new Error("Unsupported link scheme");
          const [rawPath, rawAnchor] = node.url.split("#");
          const path = decodeURIComponent(rawPath.split("?")[0]);
          const target = path
            ? resolve(
                path.startsWith("/") ? root : resolve(root, dirname(file)),
                path.replace(/^\//, ""),
              )
            : resolve(root, file);
          const local = relative(root, target).replaceAll("\\", "/");
          if (local.startsWith("../") || !existsSync(target))
            throw new Error("Target does not exist inside the repository");
          if (
            rawAnchor &&
            extname(target) === ".md" &&
            statSync(target).isFile() &&
            !anchors.get(local)?.has(decodeURIComponent(rawAnchor))
          )
            throw new Error("Heading anchor does not exist");
        } catch (error) {
          issues.push(
            `${location}: Broken link ${node.url}: ${(error as Error).message}`,
          );
        }
      }
      if (node.type === "code" && node.lang === "mermaid") {
        diagrams++;
        try {
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
          await mermaid.parse(node.value || "");
        } catch (error) {
          issues.push(
            `${location}: Invalid Mermaid diagram: ${(error as Error).message}`,
          );
        }
      }
    }
  }
  await window.happyDOM.close();
  return { issues, documents: files.length, diagrams };
}

if (import.meta.main) {
  const result = await checkDocumentation(
    resolve(process.argv[2] || resolve(import.meta.dir, "..")),
  );
  if (result.issues.length) {
    console.error(result.issues.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `Checked local links and heading anchors in ${result.documents} documents; parsed ${result.diagrams} Mermaid diagrams.`,
    );
}
