/**
 * Supported source contract v1 — what a builder may hand Zenith to publish.
 *
 * Scope (month one): a React + Vite **frontend** compiled by the platform's own
 * pinned recipe. Nothing the builder submits is executed at build time: no
 * `scripts`, no `vite.config.*`, no lockfile, no extra dependencies. Optional
 * editable backend handlers are deferred; the fixed broker is the only backend.
 *
 * Import from `@/lib/hosted/contracts`.
 */
import { z } from "zod";
import type { RecipeSpec } from "./types";
import { SUPPORTED_NODE_RANGE } from "../../node-runtime";

export const SOURCE_CONTRACT_VERSION = 1 as const;

/** The exact toolchain the recipe runs. Bump deliberately; it lands in provenance. */
export const RECIPE_V1: RecipeSpec = {
  id: "vite-react-v1",
  vite: "7.3.6",
  pluginReact: "5.1.4",
  react: "19.1.0",
  node: SUPPORTED_NODE_RANGE,
};

/** `zenith.app.json` at the source root. Required. */
export const SourceManifest = z
  .object({
    contract: z.literal(SOURCE_CONTRACT_VERSION),
    name: z.string().trim().min(1).max(60),
    schema: z.literal(1),
    /** entry HTML, relative; only the default is supported in v1 */
    entry: z.literal("index.html").prefault("index.html"),
  })
  .strict();
export type SourceManifest = z.infer<typeof SourceManifest>;

/** Dependencies a submitted package.json may declare; everything is provided by the recipe. */
export const ALLOWED_DEPENDENCIES = new Set(["react", "react-dom"]);

/**
 * Submitted `package.json` is metadata only. Any script, devDependency,
 * workspace, override or unknown dependency is unsupported input.
 */
export const SourcePackageJson = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    private: z.boolean().optional(),
    type: z.literal("module").optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const SOURCE_LIMITS = {
  maxFiles: 500,
  maxFileBytes: 2 * 1_048_576,
  maxTotalBytes: 5 * 1_048_576,
  /** decompression ceiling for a tarball, whatever it claims */
  maxDecompressedBytes: 20 * 1_048_576,
  maxPathLength: 200,
  maxDepth: 12,
} as const;

/** Allowed file extensions under src/ and public/. */
export const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ico",
  ".txt",
  ".md",
  ".woff2",
]);

/** Root files that may appear; everything else at the root is rejected. */
export const ALLOWED_ROOT_FILES = new Set(["index.html", "package.json", "zenith.app.json", "README.md"]);
export const ALLOWED_ROOT_DIRS = new Set(["src", "public"]);

/** Paths that are always unsupported, wherever they appear. */
export const REJECTED_PATTERNS: readonly RegExp[] = [
  /(^|\/)vite\.config\.[cm]?[jt]s$/,
  /(^|\/)[^/]*\.config\.[cm]?[jt]s$/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.[^/]+$/, // any other dotfile
];

export type SourceKind = "tarball" | "directory";

export interface SourceFile {
  /** forward-slash relative path, validated */
  path: string;
  bytes: Buffer;
}

export interface ValidatedSource {
  kind: SourceKind;
  manifest: SourceManifest;
  files: SourceFile[];
  /** sha256 over sorted `path\0bytes` pairs — the pinned source identity */
  digest: string;
  totalBytes: number;
}
