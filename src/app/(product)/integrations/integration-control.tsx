"use client";
/**
 * Agent integrations — who may act on this workspace through the agent API,
 * and which exact proposals a person has approved.
 *
 * Two rules shape the whole screen. Authorizing a client deploys nothing, and
 * approving a proposal executes nothing: approval authorizes one digest until
 * it expires, and the client still has to dispatch it. Every control here says
 * which of the two it is, because the difference is the security model.
 *
 * The screen is a section, not a `<main>` — the product layout already owns the
 * page's single main landmark — and it is built from the shared kit so a
 * refusal, a busy control and a disabled reason read the same here as anywhere
 * else in the product.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { KeyRound, Link2, RefreshCw, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { CodeBlock } from "@/components/ui/code-block";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeAgo } from "@/components/ui/time-ago";
import { cx, fmtDate, fmtUsd } from "@/lib/format";

interface Operation {
  id: string;
  digest: string;
  action: string;
  subject: string;
  phase: string;
  expiresAt: string;
  target: { projectId: string; environmentId?: string };
  plan: {
    summary?: string;
    details?: string[];
    warnings?: string[];
    blocked?: string;
    costDeltaUsd?: number;
    approvalRole?: string;
  };
  source?: { repository: string; commit: string; pullRequest?: number };
}
interface Grant {
  clientId: string;
  projectIds: string[];
  environmentIds?: string[];
  appIds: string[];
  scopes: string[];
  expiresAt: string;
  revoked?: boolean;
}
/**
 * One agent linked from a terminal through `zenith login` — Zenith's own
 * credential, not an OAuth grant. The two are listed separately because they
 * are different things: this one has no issuer to bind to and no second token
 * to intersect scopes with, and it is revoked by its own id.
 */
interface LinkedAgent {
  id: string;
  label: string | null;
  clientName: string | null;
  clientVersion: string | null;
  scopes: string[];
  projectIds: string[];
  environmentIds: string[] | null;
  issuedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
/** What a person needs to see before authorizing a client; supplied by the server so the screen never guesses an audience. */
interface Consent {
  issuer: string | null;
  resources: { v2: string; v3: string };
  revocationEndpoint: string;
  scopeCatalog: { name: string; oauthScope: string; summary: string; tools: string[]; alwaysIncluded: boolean }[];
}
interface State {
  workspaceId: string;
  subject: string;
  role: string;
  resource: string;
  oauthConfigured: boolean;
  projects: { id: string; name: string }[];
  grants: Grant[];
  operations: Operation[];
  linkedAgents: LinkedAgent[];
  consent?: Consent;
  /** present only when the credential authority could not be read at all */
  linkedAgentsUnavailable?: string;
}

/** Unchanged wire contract: same URLs, same method selection, same payloads. */
async function request<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok) throw Error(data?.error?.message ?? "Request failed.");
  if (data === undefined)
    throw Error("The server sent a reply this screen could not read. Reload and try again.");
  return data as T;
}

const SCOPES = ["read", "plan", "export", "write", "publish", "logs"] as const;

/** What each permission actually lets a client do, in the caller's words. */
const SCOPE_HELP: Record<(typeof SCOPES)[number], string> = {
  read: "Read projects, revisions and operations. Always included.",
  plan: "Prepare proposals for review here. Never executes anything.",
  export: "Export a project's configuration.",
  write: "Dispatch a proposal you have approved.",
  publish: "Release an app it also has an explicit owner grant for.",
  logs: "Read redacted deployment logs.",
};

/**
 * The exact access being granted, shown before the button: which client, whose
 * tokens, where the tokens are accepted, and the literal OAuth scopes. Nothing
 * here is a choice; it restates the form so a person reads what the server
 * will enforce.
 */
function ConsentSummary({
  consent,
  clientId,
  scopes,
  days,
  projectNames,
}: {
  consent?: Consent;
  clientId: string;
  scopes: string[];
  days: number;
  projectNames: string[];
}) {
  if (!consent) return null;
  const exact = [...new Set(["read", ...scopes])].map((s) => `zenith:${s}`);
  return (
    <Callout tone="info" title="You are authorizing">
      <dl className="mt-1 grid gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-[10rem_1fr]">
        <dt className="text-ink-faint">Client</dt>
        <dd className="font-mono break-all">{clientId || "(enter the client ID above)"}</dd>
        <dt className="text-ink-faint">Tokens issued by</dt>
        <dd className="font-mono break-all">
          {consent.issuer ?? "no authorization server configured"}
        </dd>
        <dt className="text-ink-faint">Accepted at</dt>
        <dd className="font-mono break-all">{consent.resources.v3}</dd>
        <dt className="text-ink-faint">Also accepted at</dt>
        <dd className="font-mono break-all">{consent.resources.v2}</dd>
        <dt className="text-ink-faint">Exact scopes</dt>
        <dd className="font-mono break-all">{exact.join(" ")}</dd>
        <dt className="text-ink-faint">Projects</dt>
        <dd>{projectNames.length ? projectNames.join(", ") : "none chosen yet"}</dd>
        <dt className="text-ink-faint">Expires</dt>
        <dd>
          {days} day{days === 1 ? "" : "s"} after you authorize
        </dd>
      </dl>
      <p className="mt-2 text-[12.5px]">
        A token minted for any other resource is refused. You can revoke this below at any time and
        the client loses access on its next request. A client can also revoke its own token at{" "}
        {consent.revocationEndpoint}.
      </p>
    </Callout>
  );
}

/** How each phase reads to a person, and how loudly. */
const PHASE: Record<string, { label: string; tone: ChipTone }> = {
  prepared: { label: "Awaiting your review", tone: "info" },
  approved: { label: "Approved — not yet dispatched", tone: "ok" },
  rejected: { label: "Rejected", tone: "neutral" },
  running: { label: "Dispatching", tone: "info" },
  succeeded: { label: "Dispatched", tone: "ok" },
  failed: { label: "Failed", tone: "err" },
  uncertain: { label: "Outcome uncertain", tone: "warn" },
  expired: { label: "Expired", tone: "neutral" },
};

type Note = { kind: "ok" | "err"; text: string };

export default function IntegrationControl() {
  const [state, setState] = useState<State>();
  const [note, setNote] = useState<Note>();
  const [loadError, setLoadError] = useState("");
  /**
   * Which control is working, not merely "something is". One boolean put a
   * spinner on every button at once and said nothing about which request was
   * in flight.
   */
  const [busyKey, setBusyKey] = useState<string>();
  const busy = busyKey !== undefined;
  const [clientId, setClientId] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [appIds, setAppIds] = useState("");
  const [days, setDays] = useState(1);
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [linked, setLinked] = useState("");
  // Expiry is a fact about the clock, so the screen re-reads it rather than
  // leaving an expired proposal looking approvable until something else
  // happens to re-render.
  const [now, setNow] = useState(() => Date.now());
  const noteRef = useRef<HTMLDivElement>(null);
  /** set while an action is settling, so focus lands on its outcome */
  const moveFocus = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setState(await request<State>("/api/integrations/agent", undefined, signal));
      setLoadError("");
    } catch (e) {
      if (!signal?.aborted)
        setLoadError(e instanceof Error ? e.message : "Could not load integrations.");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const query = new URLSearchParams(window.location.search);
    setClientId((query.get("client") ?? "").slice(0, 200));
    setLinked((query.get("operation") ?? "").slice(0, 200));
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      controller.abort();
      clearInterval(tick);
    };
  }, [load]);

  // The control that was pressed is routinely gone once the list reloads (an
  // approved proposal leaves the queue), which would drop focus to the body.
  // The outcome is where the next thing to read is, so focus goes there.
  useEffect(() => {
    if (!busy && moveFocus.current && note) {
      moveFocus.current = false;
      noteRef.current?.focus();
    }
  }, [busy, note]);

  async function act(key: string, url: string, body: unknown, success: string) {
    setBusyKey(key);
    setNote(undefined);
    moveFocus.current = true;
    try {
      await request(url, body);
      setNote({ kind: "ok", text: success });
      await load();
    } catch (e) {
      setNote({ kind: "err", text: e instanceof Error ? e.message : "Request refused." });
    } finally {
      setBusyKey(undefined);
    }
  }

  /** The refresh control, so it can say it is working without claiming a change. */
  async function reload() {
    setBusyKey("refresh");
    try {
      await load();
    } finally {
      setBusyKey(undefined);
    }
  }

  function grant(event: FormEvent) {
    event.preventDefault();
    void act(
      "grant",
      "/api/integrations/agent/grants",
      {
        clientId,
        projectIds,
        appIds: appIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        scopes,
        days,
        revoked: false,
      },
      "Integration grant saved. This does not deploy anything."
    );
  }

  const role = state?.role ?? "";
  const viewer = role === "viewer";

  return (
    <div
      className="product-page mx-auto h-full w-full max-w-[1100px] overflow-y-auto"
      aria-busy={busy || undefined}
    >
      <header className="app-page-heading">
        <div className="min-w-0">
          <h1 className="app-page-title">Agent integrations</h1>
          <p className="mt-2 max-w-[70ch] text-[14px] leading-relaxed text-ink-mute">
            Authorize narrowly scoped clients, and review the exact proposals they prepare. An
            agent can never approve its own request, and nothing on this screen deploys anything.
          </p>
        </div>
        <Button
          icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          busy={busyKey === "refresh"}
          disabled={busy && busyKey !== "refresh"}
          disabledReason="Another change is still being saved. This is available again when it settles."
          onClick={() => void reload()}
        >
          Refresh status
        </Button>
      </header>

      {/* One outcome region, and it stays until it is dismissed or replaced. */}
      <div ref={noteRef} tabIndex={-1} className="mb-6 space-y-3 outline-none">
        {loadError && (
          <Callout
            tone="err"
            title="This workspace's integrations could not be read"
            actions={
              <Button
                size="sm"
                variant="quiet"
                busy={busyKey === "refresh"}
                onClick={() => void reload()}
              >
                Try again
              </Button>
            }
          >
            <p>{loadError}</p>
          </Callout>
        )}
        {note && (
          <Callout
            tone={note.kind}
            live={note.kind === "err" ? "alert" : "status"}
            actions={
              <Button size="sm" variant="ghost" onClick={() => setNote(undefined)}>
                Dismiss
              </Button>
            }
          >
            <p>{note.text}</p>
          </Callout>
        )}
      </div>

      {!state ? (
        loadError ? null : (
          <div className="space-y-4" role="status" aria-label="Loading integrations">
            <Skeleton height={20} width="30%" />
            <Skeleton height={220} />
          </div>
        )
      ) : (
        <div className="space-y-10 pb-16">
          <section aria-labelledby="connect-heading" className="space-y-4">
            <h2 className="text-[20px] font-medium text-ink" id="connect-heading">
              Connect an OAuth client
            </h2>
            <Card>
              <p className="max-w-[70ch] text-[13px] text-ink-mute">
                Verify the client ID against your authorization provider before you authorize it.
                Local development credentials are issued by the operator, not by this screen. The
                client will reach the workspace at this resource:
              </p>
              <CodeBlock className="mt-3" title="MCP resource" code={state.resource} wrap />

              {!state.oauthConfigured ? (
                <Callout tone="info" className="mt-4" title="Remote OAuth is not configured here">
                  <p>
                    No authorization server is set for this instance, so a client cannot be
                    authorized from this screen. An operator configures one; existing grants below
                    can still be revoked.
                  </p>
                </Callout>
              ) : (
                <form onSubmit={grant} className="mt-5 space-y-5">
                  <Field
                    label="OAuth client ID"
                    required
                    help="Exactly as your authorization provider issued it."
                  >
                    <Input
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      maxLength={200}
                      required
                      autoComplete="off"
                      mono
                    />
                  </Field>

                  <fieldset className="min-w-0">
                    <legend className="text-[13px] font-medium text-ink">Projects</legend>
                    <p className="mt-0.5 mb-2 text-[12px] text-ink-faint">
                      The client sees nothing outside what you tick here. At least one is required.
                    </p>
                    {state.projects.length === 0 ? (
                      <p className="text-[13px] text-ink-mute">
                        This workspace has no projects yet, so there is nothing to authorize access
                        to.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-x-6 gap-y-2">
                        {state.projects.map((p) => (
                          <Checkbox
                            key={p.id}
                            label={p.name}
                            checked={projectIds.includes(p.id)}
                            onChange={(on) =>
                              setProjectIds((ids) =>
                                on ? [...ids, p.id] : ids.filter((id) => id !== p.id)
                              )
                            }
                          />
                        ))}
                      </div>
                    )}
                  </fieldset>

                  <fieldset className="min-w-0">
                    <legend className="text-[13px] font-medium text-ink">
                      Permitted operations
                    </legend>
                    <p className="mt-0.5 mb-2 text-[12px] text-ink-faint">
                      Read is always included. Approving a proposal is still a separate act by a
                      person, whatever is ticked here.
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {SCOPES.map((s) => {
                        const locked = s === "read";
                        const roleBlocked = viewer && (s === "write" || s === "publish");
                        return (
                          <Checkbox
                            key={s}
                            label={s}
                            help={
                              (roleBlocked
                                ? `${SCOPE_HELP[s]} Your role in this workspace is viewer, so you cannot grant it.`
                                : SCOPE_HELP[s]) + ` OAuth scope: zenith:${s}.`
                            }
                            checked={scopes.includes(s)}
                            disabled={locked || roleBlocked}
                            disabledReason={
                              locked
                                ? "Read is the minimum any client needs and cannot be removed."
                                : "Only an editor or admin can grant write or publish."
                            }
                            onChange={(on) =>
                              setScopes((values) =>
                                on ? [...values, s] : values.filter((v) => v !== s)
                              )
                            }
                          />
                        );
                      })}
                    </div>
                  </fieldset>

                  <Field
                    label="Owned app IDs for publishing"
                    help="Comma separated. Only apps you own can be listed, and only they can be published to. Leave empty if this client never publishes."
                  >
                    <Input
                      value={appIds}
                      onChange={(e) => setAppIds(e.target.value)}
                      maxLength={10000}
                      autoComplete="off"
                      mono
                    />
                  </Field>

                  <Field
                    label="Expires after"
                    help="Between 1 and 30 days. The grant stops working on its own; it does not need to be cleaned up."
                  >
                    <Input
                      type="number"
                      min={1}
                      max={30}
                      value={days}
                      onChange={(e) => setDays(Number(e.target.value))}
                      suffix="days"
                      className="w-40"
                    />
                  </Field>

                  <ConsentSummary
                    consent={state.consent}
                    clientId={clientId}
                    scopes={scopes}
                    days={days}
                    projectNames={state.projects
                      .filter((p) => projectIds.includes(p.id))
                      .map((p) => p.name)}
                  />

                  {projectIds.length === 0 && (
                    <p className="text-[12.5px] text-ink-faint">
                      Choose at least one project before this access can be authorized.
                    </p>
                  )}
                  <Button
                    type="submit"
                    variant="primary"
                    icon={<KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
                    busy={busyKey === "grant"}
                    disabled={projectIds.length === 0 || (busy && busyKey !== "grant")}
                    disabledReason={
                      projectIds.length === 0
                        ? "Choose at least one project before this access can be authorized."
                        : "Another change is still being saved."
                    }
                  >
                    Authorize selected access
                  </Button>
                </form>
              )}
            </Card>
          </section>

          <section aria-labelledby="clients-heading" className="space-y-4">
            <h2 className="text-[20px] font-medium text-ink" id="clients-heading">
              Authorized clients
            </h2>
            <Card padded={false}>
              {state.grants.length === 0 ? (
                <EmptyState
                  icon={<KeyRound className="h-5 w-5" aria-hidden="true" />}
                  title="No client is authorized yet"
                  body="Nothing can reach this workspace through the agent API until you authorize a client above."
                />
              ) : (
                <ul>
                  {state.grants.map((g) => {
                    const expired = Date.parse(g.expiresAt) <= now;
                    return (
                      <li
                        key={g.clientId}
                        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5 last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2">
                            <span className="break-all font-mono text-[12.5px] text-ink">
                              {g.clientId}
                            </span>
                            {g.revoked ? (
                              <Chip tone="neutral">revoked</Chip>
                            ) : expired ? (
                              <Chip tone="neutral">expired</Chip>
                            ) : (
                              <Chip tone="ok">active</Chip>
                            )}
                          </p>
                          <p className="mt-0.5 text-[12.5px] text-ink-mute">
                            {g.revoked
                              ? "No further request from this client is authorized."
                              : `${g.scopes.join(", ")} · ${g.projectIds.length} project${g.projectIds.length === 1 ? "" : "s"}`}
                            {" · "}
                            <span title={fmtDate(g.expiresAt)}>
                              {expired ? "expired " : "expires "}
                              <TimeAgo iso={g.expiresAt} />
                            </span>
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="quiet"
                          busy={busyKey === `revoke:${g.clientId}`}
                          disabled={Boolean(g.revoked) || (busy && busyKey !== `revoke:${g.clientId}`)}
                          disabledReason={
                            g.revoked
                              ? "This grant is already revoked, so there is nothing left to withdraw."
                              : "Another change is still being saved."
                          }
                          onClick={() =>
                            void act(
                              `revoke:${g.clientId}`,
                              "/api/integrations/agent/grants",
                              {
                                clientId: g.clientId,
                                projectIds: g.projectIds,
                                environmentIds: g.environmentIds,
                                appIds: g.appIds ?? [],
                                scopes: g.scopes,
                                days: 1,
                                revoked: true,
                              },
                              "Access revoked for subsequent requests."
                            )
                          }
                        >
                          Revoke
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </section>

          <section aria-labelledby="linked-heading" className="space-y-4">
            <h2 className="text-[20px] font-medium text-ink" id="linked-heading">
              Linked agents
            </h2>
            <p className="max-w-[70ch] text-[13px] text-ink-mute">
              Credentials you issued from a terminal by approving a link request. Revoking one
              takes effect on that agent&rsquo;s next request; nothing already dispatched is
              undone.
            </p>
            {state.linkedAgentsUnavailable && (
              <Callout tone="warn" title="Linked agents could not be read">
                <p>{state.linkedAgentsUnavailable}</p>
              </Callout>
            )}
            <Card padded={false}>
              {(state.linkedAgents ?? []).length === 0 ? (
                <EmptyState
                  icon={<Link2 className="h-5 w-5" aria-hidden="true" />}
                  title="No agents linked"
                  body="Run `zenith login` in your terminal to link one."
                />
              ) : (
                <ul>
                  {state.linkedAgents.map((agent) => {
                    const expired = Date.parse(agent.expiresAt) <= now;
                    const dead = Boolean(agent.revokedAt) || expired;
                    return (
                      <li
                        key={agent.id}
                        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5 last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2">
                            <span className="min-w-0 break-all text-[13px] text-ink">
                              {agent.label ?? agent.clientName ?? agent.id}
                            </span>
                            {agent.revokedAt ? (
                              <Chip tone="neutral">revoked</Chip>
                            ) : expired ? (
                              <Chip tone="neutral">expired</Chip>
                            ) : (
                              <Chip tone="ok">active</Chip>
                            )}
                          </p>
                          <p className="mt-0.5 text-[12.5px] text-ink-mute">
                            {agent.clientName ?? "an unnamed program"}
                            {agent.clientVersion ? ` ${agent.clientVersion}` : ""}
                            {" · "}
                            {agent.scopes.join(", ")}
                            {" · "}
                            {agent.projectIds.length} project
                            {agent.projectIds.length === 1 ? "" : "s"}
                            {" · "}
                            <span title={fmtDate(agent.expiresAt)}>
                              {expired ? "expired " : "expires "}
                              <TimeAgo iso={agent.expiresAt} />
                            </span>
                            {agent.lastUsedAt && (
                              <span title={fmtDate(agent.lastUsedAt)}>
                                {" · last used "}
                                <TimeAgo iso={agent.lastUsedAt} />
                              </span>
                            )}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="quiet"
                          busy={busyKey === `unlink:${agent.id}`}
                          disabled={dead || (busy && busyKey !== `unlink:${agent.id}`)}
                          disabledReason={
                            agent.revokedAt
                              ? "This credential is already revoked, so there is nothing left to withdraw."
                              : expired
                                ? "This credential has expired, so it already authorizes nothing."
                                : "Another change is still being saved."
                          }
                          onClick={() =>
                            void act(
                              `unlink:${agent.id}`,
                              "/api/integrations/agent/link/revoke",
                              { credentialId: agent.id },
                              "Credential revoked. It stops working on this agent's next request."
                            )
                          }
                        >
                          Revoke
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </section>

          <section aria-labelledby="proposals-heading" className="space-y-4">
            <h2 className="text-[20px] font-medium text-ink" id="proposals-heading">
              Proposals awaiting review
            </h2>
            <p className="max-w-[70ch] text-[13px] text-ink-mute">
              Approval authorizes exactly this digest until it expires. It does not execute the
              proposal — the authorized client has to dispatch it separately, and it may do so only
              once.
            </p>

            {state.operations.length === 0 ? (
              <Card padded={false}>
                <EmptyState
                  icon={<ScrollText className="h-5 w-5" aria-hidden="true" />}
                  title="Nothing is waiting for you"
                  body="Proposals prepared by an authorized client appear here, with the exact change and digest you would be approving."
                />
              </Card>
            ) : (
              state.operations.map((op) => {
                const phase = PHASE[op.phase] ?? { label: op.phase, tone: "neutral" as ChipTone };
                const expired = Date.parse(op.expiresAt) <= now;
                const needsAdmin = op.plan.approvalRole === "admin" && role !== "admin";
                const refusal = op.plan.blocked
                  ? "This proposal is blocked, so it cannot be approved."
                  : expired
                    ? "This proposal expired, so it can no longer be approved. The client has to prepare it again."
                    : needsAdmin
                      ? "This change needs an admin's approval, and your role in this workspace is not admin."
                      : undefined;
                return (
                  <Card
                    key={op.id}
                    className={cx("scroll-mt-6", linked === op.id && "ring-1 ring-signal/45")}
                    title={op.plan.summary ?? op.action}
                    actions={<Chip tone={phase.tone}>{phase.label}</Chip>}
                  >
                    {/* the anchor the client's own review link points at */}
                    <span id={op.id} />
                    <dl className="grid gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-2">
                      <div className="flex gap-2">
                        <dt className="text-ink-faint">Project</dt>
                        <dd className="min-w-0 break-all font-mono text-ink">
                          {op.target.projectId}
                          {op.target.environmentId ? ` · ${op.target.environmentId}` : ""}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-ink-faint">Requested by</dt>
                        <dd className="min-w-0 break-all font-mono text-ink">{op.subject}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-ink-faint">Estimated monthly change</dt>
                        <dd className="tnum text-ink">{fmtUsd(op.plan.costDeltaUsd ?? 0)}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-ink-faint">Approval role</dt>
                        <dd className="text-ink">{op.plan.approvalRole ?? "editor"}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-ink-faint">{expired ? "Expired" : "Expires"}</dt>
                        <dd className="text-ink" title={fmtDate(op.expiresAt)}>
                          <TimeAgo iso={op.expiresAt} />
                        </dd>
                      </div>
                      {op.source && (
                        <div className="flex gap-2">
                          <dt className="text-ink-faint">Source</dt>
                          <dd className="min-w-0 break-all font-mono text-ink">
                            {op.source.repository} @ {op.source.commit.slice(0, 12)}
                            {op.source.pullRequest ? ` · PR #${op.source.pullRequest}` : ""}
                          </dd>
                        </div>
                      )}
                    </dl>

                    {op.plan.details && op.plan.details.length > 0 && (
                      <ul className="mt-4 list-disc space-y-1 pl-5 text-[13px] text-ink">
                        {op.plan.details.map((line, index) => (
                          <li key={index}>{line}</li>
                        ))}
                      </ul>
                    )}

                    {op.plan.warnings?.map((line, index) => (
                      <Callout key={index} tone="warn" compact className="mt-3">
                        <p>{line}</p>
                      </Callout>
                    ))}

                    {op.phase === "uncertain" && (
                      <Callout tone="warn" className="mt-3" title="The outcome is not known">
                        <p>
                          Dispatch was interrupted, and it is never retried automatically. Check
                          the project&rsquo;s deployment history before approving anything further
                          for this client.
                        </p>
                      </Callout>
                    )}

                    {op.plan.blocked && (
                      <Callout tone="err" className="mt-3" title="Blocked">
                        <p>{op.plan.blocked}</p>
                      </Callout>
                    )}

                    <details className="mt-4">
                      <summary className="cursor-pointer text-[12.5px] text-ink-mute">
                        Exact proposal identity
                      </summary>
                      <CodeBlock
                        className="mt-2"
                        title="operation · digest"
                        code={`${op.id}\n${op.digest}`}
                        wrap
                      />
                    </details>

                    {op.phase === "prepared" && (
                      <div className="mt-4 space-y-2">
                        {refusal && <p className="text-[12.5px] text-ink-mute">{refusal}</p>}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="primary"
                            busy={busyKey === `approve:${op.id}`}
                            disabled={Boolean(refusal) || (busy && busyKey !== `approve:${op.id}`)}
                            disabledReason={refusal ?? "Another change is still being saved."}
                            onClick={() =>
                              void act(
                                `approve:${op.id}`,
                                "/api/integrations/agent/review",
                                { operationId: op.id, digest: op.digest, approve: true },
                                "Exact proposal approved. No execution was requested by this screen."
                              )
                            }
                          >
                            Approve exact proposal
                          </Button>
                          <Button
                            variant="quiet"
                            busy={busyKey === `reject:${op.id}`}
                            disabled={busy && busyKey !== `reject:${op.id}`}
                            disabledReason="Another change is still being saved."
                            onClick={() =>
                              void act(
                                `reject:${op.id}`,
                                "/api/integrations/agent/review",
                                { operationId: op.id, digest: op.digest, approve: false },
                                "Proposal rejected."
                              )
                            }
                          >
                            Reject
                          </Button>
                        </div>
                      </div>
                    )}
                  </Card>
                );
              })
            )}
          </section>
        </div>
      )}
    </div>
  );
}
