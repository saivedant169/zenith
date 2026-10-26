"use client";
/**
 * The working copy tab: read it, edit it, and save it through the same audited
 * action the visual editor uses. Validation runs while the operator is idle,
 * so Save's state is usually already known by the time they reach for it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Info } from "lucide-react";
import type { ActionPlan } from "@/lib/actions/core";
import { planAction } from "@/lib/client/api";
import { diffManifests, validateManifest, type ValidationIssue } from "@/lib/domain/graph";
import type { AnyManifest } from "@/lib/domain/types";
import { parseEditableManifest } from "@/lib/actions/defs/_manifest";
import { fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { CodeBlock } from "@/components/ui/code-block";
import { CostDelta } from "@/components/ui/cost-delta";
import { Kbd } from "@/components/ui/kbd";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useExternalValue } from "@/components/ui/use-external-value";
import { useAsync } from "@/components/screens/use-async";
import { EditorBoundary } from "@/components/screens/editor-boundary";
import { ActionConfirm, ChangeRow, ErrorNote } from "@/components/screens/shared";
import { describeJsonError, type JsonErrorSite } from "./json-error";

const SAVE_NOTE =
  "Review validates your source and estimates its changes before saving the working copy. Deploy separately from the System map.";

/** Idle time before the editor checks the document on its own. */
const VALIDATE_DEBOUNCE_MS = 400;
/**
 * Line numbers stop being drawn past this. The gutter is decoration
 * (`aria-hidden`) and rebuilding a 5000-entry string on every newline is the
 * only per-keystroke cost the editor has; the textarea itself is unaffected.
 */
const MAX_GUTTER_LINES = 5000;

type ParseState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "error"; message: string; site?: JsonErrorSite }
  | { kind: "ok"; manifest: AnyManifest; issues: ValidationIssue[] };

/** One pass, no array of N strings — this runs on every keystroke. */
function countLines(s: string): number {
  let n = 1;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
}

/* ------------------------------ working copy ------------------------------ */

export function WorkingTab({
  active,
  json,
  manifest,
  manifestHash,
  projectId,
  slug,
  onDirtyChange,
  refresh,
}: {
  active: boolean;
  json: string;
  manifest: AnyManifest;
  /** concurrency token for `json` — travels with it, never apart from it */
  manifestHash: string;
  projectId: string;
  slug: string;
  onDirtyChange: (dirty: boolean) => void;
  refresh: () => void;
}) {
  const [mode, setMode] = useState<"read" | "edit">("read");
  /**
   * The token for the copy `text` started from — deliberately NOT updated when
   * the working copy moves under an edit, because that stale value is exactly
   * what makes the server refuse the overwrite.
   */
  const [baseHash, setBaseHash] = useState(manifestHash);
  // The working copy can change under us (map edits, Navigator runs, another
  // tab). Adopt the new text when nothing is being edited; when something is,
  // keep what is typed and say so rather than silently losing either version.
  const {
    draft: text,
    setDraft: setText,
    movedUnderYou: movedWhileEditing,
    acknowledge: dismissMoved,
    reset: resetToSaved,
    adopt: adoptSaved,
  } = useExternalValue(
    json,
    (value: string) => value,
    () => setBaseHash(manifestHash)
  );
  const [parse, setParse] = useState<ParseState>({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [hint, setHint] = useState<string>();
  const [serverPlan, setServerPlan] = useState<ActionPlan>();
  const { busy: planning, error: planError, run: runPlan, clearError: clearPlanError } = useAsync<void>();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterBoxRef = useRef<HTMLDivElement>(null);
  const gutterTextRef = useRef<HTMLPreElement>(null);

  /** Take the saved copy as the new starting point — text and token together. */
  const loadTheirs = () => {
    resetToSaved();
    setBaseHash(manifestHash);
  };

  /** This page knows the copy moved: reload/revert is the fix, not retrying. */
  const staleSave = baseHash !== manifestHash;

  const dirty = text !== json;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const validate = useCallback((source: string) => {
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (e) {
      setParse({ kind: "error", ...describeJsonError(source, e) });
      return;
    }
    const parsed = parseEditableManifest(raw);
    if (!parsed.ok) {
      const first = parsed.errors[0];
      setParse({
        kind: "error",
        message: `${first.path || "manifest"}: ${first.message}. ${parsed.errors.length - 1} other schema problem(s).`,
      });
      return;
    }
    setParse({
      kind: "ok",
      manifest: parsed.manifest,
      issues: validateManifest(parsed.manifest),
    });
  }, []);

  // Validate while the operator is idle, so Save's state is usually already
  // known by the time they reach for it. The button below is still explicit.
  useEffect(() => {
    setParse({ kind: "checking" });
    setHint(undefined);
    setServerPlan(undefined);
    clearPlanError();
    const t = setTimeout(() => validate(text), VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, validate, clearPlanError]);

  const changeset =
    parse.kind === "ok" ? diffManifests(manifest, parse.manifest) : undefined;
  const blockingIssues =
    parse.kind === "ok" && parse.issues.some((i) => i.level === "error");

  const lineCount = useMemo(() => countLines(text), [text]);
  const errLine = parse.kind === "error" ? parse.site?.line : undefined;
  const gutter = useMemo(() => gutterRows(lineCount, errLine), [lineCount, errLine]);
  const readLines = useMemo(() => countLines(json), [json]);

  /** Select the offending character and put its line on screen. */
  const revealSite = useCallback(
    (site: JsonErrorSite) => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(site.offset, Math.min(site.offset + 1, area.value.length));
      // Measured, not assumed: the gutter block is exactly as tall as the rows
      // it drew, so one row is its height over its row count.
      const pre = gutterTextRef.current;
      const rows = Math.min(lineCount, MAX_GUTTER_LINES);
      const rowHeight = pre && rows > 0 ? pre.getBoundingClientRect().height / rows : 0;
      if (rowHeight > 0)
        area.scrollTop = Math.max(0, (site.line - 1) * rowHeight - area.clientHeight / 3);
    },
    [lineCount]
  );

  const saveBlockedReason = !dirty
    ? "Nothing to save — the text matches the working copy."
    : parse.kind === "checking" || parse.kind === "idle"
      ? "Checking the JSON — this settles in a moment."
      : parse.kind === "error"
        ? "The document does not parse — fix the error shown below."
        : blockingIssues
          ? "Fix the validation errors first; they would block the next deploy."
          : undefined;

  /* S5 — Ctrl/Cmd+S saves, and says why when it cannot. */
  useEffect(() => {
    if (!active || mode !== "edit") return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      if (saveBlockedReason) setHint(saveBlockedReason);
      else setConfirmOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, mode, saveBlockedReason]);

  /* S3 — a reload or a closed tab is the one navigation the browser lets us stop. */
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  /** S11 — what the server says this same save would do, on demand. */
  const previewServerPlan = () => {
    if (parse.kind !== "ok") return;
    void runPlan(async () => {
      setServerPlan(
        await planAction("project.updateManifest", {
          // Same token the save sends, so this preview is the real save's plan
          // — including its refusal, if the copy moved under the editor.
          input: { manifest: parse.manifest, expectedHash: baseHash },
          scope: { projectId },
        })
      );
    });
  };

  const costDisagrees =
    !!serverPlan &&
    !!changeset &&
    Math.abs(serverPlan.costDeltaUsd - changeset.totalCostDeltaUsd) >= 0.01;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<"read" | "edit">
          label="Source mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "read", label: "Read", title: "The working manifest, formatted" },
            { value: "edit", label: "Edit", title: "Edit and validate before applying" },
          ]}
        />
        <p className="tnum font-mono text-[12px] text-ink-mute">
          {readLines} lines · {manifest.services.length} services ·{" "}
          {manifest.resources.length} resources · {manifest.bindings.length} bindings
        </p>
      </div>

      {movedWhileEditing && (
        <Callout
          tone="warn"
          actions={
            <>
              <Button size="sm" variant="quiet" onClick={loadTheirs}>
                Discard mine, load theirs
              </Button>
              <Button size="sm" variant="ghost" onClick={dismissMoved}>
                Keep editing
              </Button>
            </>
          }
        >
          The saved working copy changed while you were editing. Your text is preserved.
          Review both versions before choosing whether to replace the newer copy.
        </Callout>
      )}

      {mode === "read" ? (
        <CodeBlock code={json} title="zenith.manifest.json" lineNumbers maxHeight={560} />
      ) : (
        <EditorBoundary onRestore={loadTheirs}>
          <div className="space-y-4">
            {/*
              A textarea with a line-number gutter — no editor dependency, on
              purpose. The gutter is a single pre scrolled from the textarea's
              own scroll event; `wrap="off"` is what keeps the two in step,
              since a soft-wrapped line would take two rows in the textarea and
              one in the gutter. Height follows the viewport (S14).
            */}
            <div className="overflow-hidden rounded-card border border-line bg-bg2 focus-within:border-signal">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-bg1 px-4 py-2.5">
                <span className="font-mono text-[12px] text-ink-mute">zenith.manifest.json</span>
                <span role="status" className={`flex items-center gap-1.5 text-[12px] ${dirty ? "text-warn" : "text-ok"}`}>{dirty ? <><span aria-hidden="true">●</span> Unsaved text</> : <><Check className="h-3.5 w-3.5" aria-hidden="true" /> Saved working copy</>}</span>
              </div>
              <div className="flex h-[clamp(320px,calc(100dvh-350px),820px)]">
              <div
                ref={gutterBoxRef}
                aria-hidden="true"
                className="shrink-0 overflow-hidden border-r border-line bg-bg1 py-4 pr-3 pl-4 select-none"
              >
                <pre
                  ref={gutterTextRef}
                  className="tnum m-0 text-right font-mono text-[14px] leading-[1.75] text-ink-faint"
                >
                  {gutter}
                </pre>
              </div>
              <textarea
                ref={areaRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onScroll={(e) => {
                  if (gutterBoxRef.current)
                    gutterBoxRef.current.scrollTop = e.currentTarget.scrollTop;
                }}
                spellCheck={false}
                wrap="off"
                aria-label="Manifest JSON"
                aria-invalid={parse.kind === "error" || Boolean(blockingIssues)}
                className="h-full min-w-0 w-full resize-none bg-transparent p-4 font-mono text-[14px] leading-[1.75] text-ink outline-none"
              />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="quiet" onClick={() => validate(text)}>
                Validate
              </Button>
              <Button
                variant="quiet"
                disabled={parse.kind !== "ok" && parse.kind !== "checking"}
                disabledReason="The document does not parse, so there is nothing to reformat."
                title="Re-indent the JSON with two spaces"
                onClick={() => {
                  try {
                    setText(JSON.stringify(JSON.parse(text), null, 2));
                  } catch {
                    setHint("The document does not parse — fix the error below, then format.");
                  }
                }}
              >
                Format
              </Button>
              <Button
                disabled={Boolean(saveBlockedReason)}
                disabledReason={saveBlockedReason}
                title="Save (Ctrl/Cmd+S)"
                onClick={() => setConfirmOpen(true)}
              >
                Review & save
              </Button>
              <span className="hidden items-center gap-1 text-ink-faint sm:flex">
                <Kbd>Ctrl</Kbd>
                <Kbd>S</Kbd>
              </span>
              <Button
                variant="ghost"
                disabled={!dirty}
                disabledReason="The text already matches the working copy."
                onClick={loadTheirs}
              >
                Revert
              </Button>
              <ParseStatus parse={parse} />
            </div>

            {hint && (
              <p role="status" className="text-[12.5px] text-warn">
                {hint}
              </p>
            )}

            <div className="flex gap-2.5 border-t border-line py-3 text-[13px] text-ink-mute">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
              <p>{SAVE_NOTE}</p>
            </div>

            {parse.kind === "error" && (
              <div role="status" className="space-y-2">
                <ErrorNote error={new Error(parse.message)} />
                {parse.site ? <GoToLine site={parse.site} onGo={revealSite} /> : null}
              </div>
            )}

            {parse.kind === "ok" && <IssueList issues={parse.issues} slug={slug} />}

            {changeset && (
              <Card
                title={
                  changeset.items.length === 0
                    ? "No difference"
                    : `${changeset.items.length} change${changeset.items.length === 1 ? "" : "s"} vs the working copy`
                }
                subtitle={
                  changeset.items.length === 0
                    ? "This text describes the same system that is already loaded."
                    : `Projected ${fmtUsd(changeset.projectedMonthlyUsd)}/month after these changes (estimate), counted in this browser.`
                }
                actions={
                  changeset.items.length > 0 ? (
                    <CostDelta usd={changeset.totalCostDeltaUsd} />
                  ) : undefined
                }
                padded={changeset.items.length === 0}
              >
                {changeset.items.length === 0 ? null : (
                  <ul className="-mx-1">
                    {changeset.items.map((i) => (
                      <ChangeRow key={`${i.op}-${i.nodeId}`} item={i} />
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {changeset && changeset.items.length > 0 && (
              <div className="space-y-2 rounded-card border border-line bg-bg1 px-4 py-3 text-[12.5px] text-ink-mute">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1">
                    This comparison is calculated locally. Check it against the server&apos;s authoritative save plan.
                  </span>
                  <Button size="sm" variant="quiet" busy={planning} onClick={previewServerPlan}>
                    Compare with the server&apos;s plan
                  </Button>
                </div>
                {planError ? <ErrorNote error={planError} /> : null}
                {serverPlan?.blocked ? (
                  <p role="alert" className="text-err">
                    {serverPlan.blocked}
                  </p>
                ) : serverPlan ? (
                  <div role="status" className="space-y-1">
                    <p className={costDisagrees ? "text-warn" : "text-ink"}>
                      {costDisagrees
                        ? `The two disagree: this page estimates ${fmtUsd(changeset.totalCostDeltaUsd)}/month, the server's plan estimates ${fmtUsd(serverPlan.costDeltaUsd)}/month. Trust the server's — reload the page to pick up whatever changed underneath.`
                        : `Agreed: both estimate it makes it ${fmtUsd(serverPlan.costDeltaUsd)}/month different.`}
                    </p>
                    <p className="text-ink-mute">{serverPlan.summary}</p>
                    {serverPlan.warnings.map((w) => (
                      <p key={w} className="text-warn">
                        {w}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            )}

            <ActionConfirm
              open={confirmOpen}
              onClose={() => setConfirmOpen(false)}
              actionId="project.updateManifest"
              /*
               * The hash of the copy this text was loaded from. A save that
               * raced another writer is refused instead of overwriting them —
               * the banner above covers the case this page can see, the token
               * covers the one it cannot.
               */
              input={
                parse.kind === "ok"
                  ? { manifest: parse.manifest, expectedHash: baseHash }
                  : undefined
              }
              scope={{ projectId }}
              title="Save manifest source"
              description="Replaces the working copy. Nothing deploys until you review and apply the pending changes."
              confirmLabel="Save changes"
              danger={Boolean(changeset?.items.some((i) => i.risk === "high"))}
              blockedFix={
                staleSave ? (
                  <>
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => {
                        setConfirmOpen(false);
                        loadTheirs();
                      }}
                    >
                      Discard my edits, load the saved copy
                    </Button>
                    {/* Rebasing the token re-plans this save against the copy
                        that is there now — the preview above updates in place. */}
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => setBaseHash(manifestHash)}
                    >
                      Keep my text and overwrite it
                    </Button>
                  </>
                ) : undefined
              }
              onDone={(result) => {
                if (!result.ok || parse.kind !== "ok") return;
                // The save is the new baseline: adopt the text just stored and
                // the token the server handed back, so the next poll is not
                // mistaken for someone else moving the copy underneath.
                const saved = JSON.stringify(parse.manifest, null, 2);
                const next = (result.data as { manifestHash?: string } | undefined)?.manifestHash;
                adoptSaved(saved);
                if (next) setBaseHash(next);
                setConfirmOpen(false);
                setMode("read");
                refresh();
              }}
            />
          </div>
        </EditorBoundary>
      )}
    </div>
  );
}

/** The gutter as one text node, with the failing line marked. */
function gutterRows(lineCount: number, errLine: number | undefined) {
  const rows = Math.min(lineCount, MAX_GUTTER_LINES);
  const range = (from: number, to: number) => {
    let s = "";
    for (let i = from; i <= to; i++) s += (i > from ? "\n" : "") + i;
    return s;
  };
  if (!errLine || errLine > rows) return range(1, rows);
  return (
    <>
      {errLine > 1 ? `${range(1, errLine - 1)}\n` : ""}
      <span className="font-medium text-err">{errLine}</span>
      {errLine < rows ? `\n${range(errLine + 1, rows)}` : ""}
    </>
  );
}

/** One quiet line so the debounced check is never a silent state change. */
function ParseStatus({ parse }: { parse: ParseState }) {
  const text =
    parse.kind === "checking"
      ? "Checking…"
      : parse.kind === "ok" && !parse.issues.some((i) => i.level === "error")
        ? "Checked · parses"
        : "";
  return (
    <span role="status" className="text-[12.5px] text-ink-faint">
      {text}
    </span>
  );
}

function GoToLine({
  site,
  onGo,
}: {
  site: JsonErrorSite;
  onGo: (site: JsonErrorSite) => void;
}) {
  return (
    <Button size="sm" variant="quiet" onClick={() => onGo(site)}>
      Go to line {site.line}, column {site.column}
    </Button>
  );
}

function IssueList({ issues, slug }: { issues: ValidationIssue[]; slug: string }) {
  if (issues.length === 0)
    return (
      <Callout tone="ok">Valid manifest — schema and structure both check out.</Callout>
    );
  return (
    <Card title={`${issues.length} issue${issues.length === 1 ? "" : "s"}`} padded={false}>
      <ul>
        {issues.map((i, idx) => (
          <li
            key={idx}
            className="flex items-start gap-3 border-b border-line px-5 py-3 last:border-b-0"
          >
            <AlertTriangle
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${i.level === "error" ? "text-err" : "text-warn"}`}
            />
            <div className="min-w-0">
              <p className="text-[13px] text-ink">{i.message}</p>
              {i.fix && <p className="mt-0.5 text-[12.5px] text-ink-mute">{i.fix}</p>}
              {i.nodeId && (
                <Link
                  href={`/p/${slug}?select=${encodeURIComponent(i.nodeId)}`}
                  className="mt-0.5 inline-block font-mono text-[11.5px] text-signal hover:underline"
                  title="Open this node on the System map"
                >
                  {i.nodeId} — show on map
                </Link>
              )}
            </div>
            <Chip tone={i.level === "error" ? "err" : "warn"} className="ml-auto shrink-0">
              {i.level}
            </Chip>
          </li>
        ))}
      </ul>
    </Card>
  );
}
