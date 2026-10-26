"use client";
import { useEffect, useRef } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Archive,
  CalendarClock,
  Cog,
  Database,
  FileCode2,
  Globe,
  ListOrdered,
  Lock,
  Mail,
  Server,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Chip } from "@/components/ui/chip";
import { StatusDot, type DotStatus } from "@/components/ui/status-dot";
import { cx, fmtUsd } from "@/lib/format";
import type { Ownership } from "@/lib/domain/types";
import type { DriftItem } from "@/lib/drift";
import { NODE_SIZE, type Stratum } from "./layout";

export interface MapNodeData extends Record<string, unknown> {
  name: string;
  stratum: Stratum;
  /** service kind, resource kind, or "route" */
  kind: string;
  /** the one line of detail under the name */
  sub?: string;
  costUsd: number;
  /** undefined when there is no health source (nothing deployed here yet) */
  health?: DotStatus;
  healthLabel?: string;
  /** how this node differs from what the selected environment runs */
  diff?: "create" | "update" | "delete";
  /**
   * How this node differs from what the provider actually FOUND — the other
   * direction entirely from `diff`, which is about what has not been deployed
   * yet. Absent when nothing is deployed, when the provider cannot observe, or
   * when the node matches.
   */
  drift?: Pick<DriftItem, "kind" | "severity" | "detail">;
  ownership?: Ownership;
  /** a deployment is touching this node right now */
  live?: boolean;
  tls?: boolean;
  bindState?: "source" | "candidate";
  selected?: boolean;
  /** this node holds the graph's single tab stop (roving tabIndex) */
  focused?: boolean;
  /** "3 of 7" — where this node sits in the keyboard order */
  posLabel?: string;
  /** names of everything bound to or from this node, for the accessible name */
  connections?: string[];
  /** a filter is running and this node is not one of the matches */
  dimmed?: boolean;
  onActivate?: () => void;
  /** the graph took focus here — usually via Tab or an arrow key */
  onFocus?: () => void;
  /** arrow keys walk the keyboard order: -1 back, +1 forward */
  onNav?: (delta: -1 | 1) => void;
  /** right-click, or the context-menu key, in viewport coordinates */
  onMenu?: (x: number, y: number) => void;
}

export type MapNode = Node<MapNodeData, "route" | "service" | "resource">;

const SERVICE_ICON: Record<string, LucideIcon> = {
  web: Server,
  worker: Cog,
  cron: CalendarClock,
  static: FileCode2,
};

const RESOURCE_ICON: Record<string, LucideIcon> = {
  postgres: Database,
  redis: Zap,
  object_store: Archive,
  queue: ListOrdered,
  email: Mail,
};

const KIND_LABEL: Record<string, string> = {
  web: "web service",
  worker: "worker",
  cron: "scheduled job",
  static: "static site",
  postgres: "postgres",
  redis: "redis",
  object_store: "object store",
  queue: "queue",
  email: "email",
};

function iconFor(data: MapNodeData): LucideIcon {
  if (data.stratum === "route") return Globe;
  if (data.stratum === "service") return SERVICE_ICON[data.kind] ?? Server;
  return RESOURCE_ICON[data.kind] ?? Database;
}

/** Edge anchors: visible enough to read the direction, never a drag target. */
const HANDLE: React.CSSProperties = {
  width: 6,
  height: 6,
  border: "none",
  background: "var(--line-strong)",
  minWidth: 0,
  minHeight: 0,
};

const DIFF_TITLE: Record<NonNullable<MapNodeData["diff"]>, string> = {
  create: "Not deployed yet — the next deploy to this environment creates it.",
  update: "Changed since the last deploy to this environment.",
  delete: "Still running — the next deploy to this environment removes it.",
};

const DRIFT_TITLE: Record<DriftItem["kind"], string> = {
  missing: "drift: deployed here, but the provider cannot find it",
  changed: "drift: does not match the revision deployed here",
  extra: "drift: present here, and nothing deployed owns it",
};

const BIND_LABEL: Record<NonNullable<MapNodeData["bindState"]>, string> = {
  source: "picked as the source of the new connection",
  candidate: "can be the target of the new connection",
};

/**
 * What a screen reader says for a node: what it is, then how it differs from
 * the deployed system, then its state — the same order the node reads visually.
 */
function accessibleName(data: MapNodeData): string {
  const parts = [
    data.name,
    data.stratum === "route" ? "route" : (KIND_LABEL[data.kind] ?? data.kind),
  ];
  if (data.stratum === "route") parts.push(data.tls ? "TLS on" : "no TLS");
  if (data.sub) parts.push(data.sub);
  if (data.diff) parts.push(DIFF_TITLE[data.diff]);
  if (data.drift) parts.push(DRIFT_TITLE[data.drift.kind]);
  if (data.healthLabel) parts.push(data.healthLabel);
  // The bindings are the point of the map, and a screen reader could not hear
  // them at all: edges have no accessible presence of their own.
  parts.push(
    data.connections?.length
      ? `connected to ${data.connections.join(", ")}`
      : "not connected to anything"
  );
  if (data.bindState) parts.push(BIND_LABEL[data.bindState]);
  if (data.selected) parts.push("open in the inspector");
  if (data.dimmed) parts.push("does not match the current filter");
  if (data.posLabel) parts.push(data.posLabel);
  return parts.join(", ");
}

/** Shared chrome: diff treatment, ownership, focus, bind-mode affordances. */
function NodeShell({
  id,
  data,
  children,
  className,
}: {
  id: string;
  data: MapNodeData;
  children: React.ReactNode;
  className?: string;
}) {
  const selected = Boolean(data.selected);
  const size = NODE_SIZE[data.stratum];
  const ghost = data.diff === "delete";
  const referenced = data.ownership && data.ownership !== "managed";
  const ref = useRef<HTMLDivElement>(null);

  // Roving focus: only the node the graph considers current is tabbable, so
  // the whole map is one tab stop. When an arrow key moves that flag, the DOM
  // focus has to follow it — but only if focus was already inside the graph,
  // otherwise a background poll would steal it from wherever the user is.
  useEffect(() => {
    if (!data.focused) return;
    const active = document.activeElement;
    if (active === ref.current) return;
    if (active instanceof HTMLElement && active.dataset.mapNode) ref.current?.focus();
  }, [data.focused]);

  return (
    // Filtered-out nodes fade rather than disappear: the map must keep showing
    // the whole system, or it stops agreeing with the Changes panel.
    <div
      className="relative transition-opacity duration-[var(--dur-base)] [transition-timing-function:var(--ease-swift)]"
      style={{ width: size.width, height: size.height, opacity: data.dimmed ? 0.28 : undefined }}
    >
      {data.live && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-1 rounded-card ring-2 ring-signal/55"
        />
      )}
      <Handle type="target" position={Position.Left} isConnectable={false} style={HANDLE} />
      <div
        ref={ref}
        data-map-node="true"
        data-node-id={id}
        role="button"
        tabIndex={data.focused ? 0 : -1}
        aria-label={accessibleName(data)}
        title={data.diff ? DIFF_TITLE[data.diff] : undefined}
        onClick={() => data.onActivate?.()}
        onFocus={() => data.onFocus?.()}
        onContextMenu={(e) => {
          if (!data.onMenu) return;
          e.preventDefault();
          data.onMenu(e.clientX, e.clientY);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            data.onActivate?.();
          } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
            e.preventDefault();
            data.onNav?.(1);
          } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
            e.preventDefault();
            data.onNav?.(-1);
          } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            // The same menu the mouse gets, opened at the node's own corner.
            e.preventDefault();
            const box = ref.current?.getBoundingClientRect();
            if (box) data.onMenu?.(box.left + 12, box.bottom - 6);
          }
        }}
        className={cx(
          "relative flex h-full w-full flex-col justify-center overflow-hidden rounded-card bg-bg2 px-4 text-left",
          "transition-[border-color,box-shadow,opacity] duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)]",
          "border shadow-[0_2px_0_var(--line)]",
          ghost
            ? "border-dashed border-err"
            : data.diff === "create"
              ? "border-dashed border-signal"
              : referenced
                ? "border-dashed border-line-strong"
                : "border-line",
          selected && "border-signal ring-1 ring-signal",
          data.bindState === "source" && "ring-2 ring-signal",
          data.bindState === "candidate" && "cursor-crosshair hover:border-signal",
          !data.bindState && "hover:border-line-strong",
          className
        )}
      >
        {children}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} style={HANDLE} />
    </div>
  );
}

function DiffMark({ diff }: { diff?: MapNodeData["diff"] }) {
  if (diff === "create") return <Chip tone="signal">new</Chip>;
  if (diff === "delete") return <Chip tone="err">removing</Chip>;
  if (diff === "update")
    return <Chip tone="signal">changed</Chip>;
  return null;
}

/**
 * Drift chip — deliberately the same visual grammar as DiffMark, because a
 * reader is asking the same question of both: "is this node not what I think?"
 * The tooltip carries the sentence; the chip only has room for the word.
 */
function DriftMark({ drift }: { drift?: MapNodeData["drift"] }) {
  if (!drift) return null;
  return (
    <Chip tone={drift.severity === "high" ? "err" : "warn"} title={drift.detail}>
      drift
    </Chip>
  );
}

function Cost({ usd }: { usd: number }) {
  return (
    <span className="tnum shrink-0 font-mono text-[11.5px] text-ink-faint" title="Estimated monthly cost at list prices.">
      {fmtUsd(usd)}
      <span className="opacity-70">/mo est.</span>
    </span>
  );
}

export function RouteNode({ id, data }: NodeProps<MapNode>) {
  return (
    <NodeShell id={id} data={data}>
      <div className="flex items-center gap-2">
        <Globe className="h-3.5 w-3.5 shrink-0 text-ink-mute" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-all font-mono text-[12px] leading-[1.45] text-ink" title={data.name}>
          {data.name}
        </span>
        {data.tls && (
          <Lock className="h-3 w-3 shrink-0 text-ok" aria-label="TLS" />
        )}
        <DiffMark diff={data.diff} />
        <DriftMark drift={data.drift} />
      </div>
    </NodeShell>
  );
}

export function ServiceNode({ id, data }: NodeProps<MapNode>) {
  const Icon = iconFor(data);
  return (
    <NodeShell id={id} data={data}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-ink-mute" aria-hidden="true" />
        <span className="min-w-0 flex-1 line-clamp-2 break-all text-[14px] leading-[1.4] font-semibold text-ink" title={data.name}>
          {data.name}
        </span>
        <DiffMark diff={data.diff} />
        <DriftMark drift={data.drift} />
        {data.health && <StatusDot status={data.health} label={data.healthLabel} />}
      </div>
      <div className="mt-3 flex items-baseline gap-2 border-t border-line pt-2">
        <span
          className="min-w-0 flex-1 text-[12px] leading-[1.4] text-ink-mute"
          title={`${KIND_LABEL[data.kind] ?? data.kind}${data.sub ? ` · ${data.sub}` : ""}`}
        >
          {KIND_LABEL[data.kind] ?? data.kind}
          {data.sub ? ` · ${data.sub}` : ""}
        </span>
        <Cost usd={data.costUsd} />
      </div>
      {data.ownership && data.ownership !== "managed" && (
        <span className="mt-1 text-[10.5px] tracking-[0.04em] text-ink-faint uppercase">
          {data.ownership}
        </span>
      )}
    </NodeShell>
  );
}

export function ResourceNode({ id, data }: NodeProps<MapNode>) {
  const Icon = iconFor(data);
  return (
    <NodeShell id={id} data={data}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-ink-mute" aria-hidden="true" />
        <span className="min-w-0 flex-1 line-clamp-2 break-all text-[14px] leading-[1.4] font-semibold text-ink" title={data.name}>
          {data.name}
        </span>
        <DiffMark diff={data.diff} />
        <DriftMark drift={data.drift} />
      </div>
      <div className="mt-3 flex items-baseline gap-2 border-t border-line pt-2">
        <span
          className="min-w-0 flex-1 text-[12px] leading-[1.4] text-ink-mute"
          title={`${KIND_LABEL[data.kind] ?? data.kind}${data.sub ? ` · ${data.sub}` : ""}`}
        >
          {KIND_LABEL[data.kind] ?? data.kind}
          {data.sub ? ` · ${data.sub}` : ""}
        </span>
        <Cost usd={data.costUsd} />
      </div>
      {data.ownership && data.ownership !== "managed" && (
        <span className="mt-0.5 text-[10.5px] tracking-[0.04em] text-ink-faint uppercase">
          {data.ownership}
        </span>
      )}
    </NodeShell>
  );
}

export const nodeTypes = {
  route: RouteNode,
  service: ServiceNode,
  resource: ResourceNode,
};
