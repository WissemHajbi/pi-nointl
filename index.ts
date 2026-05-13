import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";

type ScanResult = {
  plugin: string;
  path: string;
  issueCount: number;
  issues: Array<{
    file: string;
    line: number;
    col: number;
    tag: string;
    text: string;
  }>;
};

const require = createRequire(import.meta.url);
const NOINTL_BIN = require.resolve("@wissem_hajbi/nointl/bin/nointl.js");

function tokenizeArgs(raw: string) {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (
        ch === "\\" &&
        i + 1 < raw.length &&
        (raw[i + 1] === quote || raw[i + 1] === "\\")
      ) {
        current += raw[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) parts.push(current);
  return parts;
}

function parseArgs(raw: string, fallbackPath: string) {
  const parts = tokenizeArgs(raw);
  const positionals: string[] = [];
  let plugin: string | undefined;
  let path: string | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "--plugin" && parts[i + 1]) {
      plugin = parts[++i];
      continue;
    }
    if (part === "--path" && parts[i + 1]) {
      path = parts[++i];
      continue;
    }
    if (!part.startsWith("-")) positionals.push(part);
  }

  if (!plugin && !path) {
    if (positionals.length === 1) path = positionals[0];
    else if (positionals.length >= 2) {
      plugin = positionals[0];
      path = positionals[1];
    }
  } else if (plugin && !path) {
    path = positionals[0];
  } else if (!plugin && path) {
    plugin = positionals[0];
  }

  return { plugin, path: path ?? fallbackPath };
}

function summarize(result: ScanResult) {
  const lines: string[] = [];
  lines.push(`${result.issueCount} issue(s) found in ${result.path}`);
  for (const issue of result.issues.slice(0, 10)) {
    lines.push(`- ${issue.file}:${issue.line}:${issue.col} [${issue.tag}] ${issue.text}`);
  }
  if (result.issues.length > 10) {
    lines.push(`- ...and ${result.issues.length - 10} more`);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  async function runScan(
    cwd: string,
    scanPath: string,
    plugin: string,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    code: number | null;
    result?: ScanResult;
  }> {
    const execArgs = ["--json", "--plugin", plugin, "--path", scanPath];
    const result = await pi.exec(process.execPath, [NOINTL_BIN, ...execArgs], {
      cwd,
      signal,
    });

    let parsed: ScanResult | undefined;
    if (result.stdout.trim()) {
      try {
        parsed = JSON.parse(result.stdout) as ScanResult;
      } catch {
        parsed = undefined;
      }
    }

    return {
      ok: result.code === 0 && !!parsed,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code,
      result: parsed,
    };
  }

  pi.registerTool({
    name: "scan_untranslated_strings",
    label: "NoIntl Scan",
    description: "Scan a directory for untranslated strings using nointl",
    promptSnippet: "Scan a directory for untranslated strings",
    promptGuidelines: [
      "Use scan_untranslated_strings when the user asks to check a Next.js project for untranslated strings.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description: "Directory to scan. Defaults to the current working directory.",
        }),
      ),
      plugin: Type.Optional(
        Type.String({
          description: "Plugin to use. Defaults to next-intl.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const scanPath = params.path ?? ctx.cwd;
      const plugin = params.plugin ?? "next-intl";

      onUpdate?.({
        content: [{ type: "text", text: `Scanning ${scanPath} with ${plugin}...` }],
      });

      const run = await runScan(ctx.cwd, scanPath, plugin, signal);
      if (!run.ok || !run.result) {
        const message = run.stderr.trim() || run.stdout.trim() || "Scan failed";
        return {
          content: [{ type: "text", text: message }],
          details: {
            ok: false,
            path: scanPath,
            plugin,
            code: run.code,
            stdout: run.stdout,
            stderr: run.stderr,
          },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: summarize(run.result) }],
        details: run.result,
      };
    },
  });

  pi.registerCommand("nointl-scan", {
    description: "Scan a directory for untranslated strings",
    handler: async (args, ctx) => {
      const { plugin, path: scanPath } = parseArgs(args ?? "", ctx.cwd);
      const run = await runScan(ctx.cwd, scanPath, plugin ?? "next-intl", ctx.signal);

      if (!run.ok || !run.result) {
        ctx.ui.notify(run.stderr.trim() || run.stdout.trim() || "Scan failed", "error");
        return;
      }

      ctx.ui.notify(summarize(run.result), run.result.issueCount === 0 ? "success" : "warning");
    },
  });
}
