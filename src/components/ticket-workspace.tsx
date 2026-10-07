"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  ArrowDown,
  Check,
  Circle,
  CircleDashed,
  CircleDot,
  CircleHelp,
  Columns3,
  FolderKanban,
  Layers2,
  Loader2,
  LockKeyhole,
  LogOut,
  PanelLeft,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { priorities, type Priority, type Ticket } from "@/lib/domain";
import type { SessionInfo } from "@/lib/agent-gate";
import type { DiscoveryVariant } from "@/lib/research/discovery-variant";
import { cn } from "@/lib/utils";

const errorMessages: Record<string, string> = {
  registration_required: "Save was blocked by the workspace access policy.",
  permission_denied: "Your account doesn't have permission to change this ticket.",
  version_conflict:
    "This ticket changed since you opened it. Close and reopen it to load the latest version.",
  session_expired: "Your session expired. Reload the page to start a fresh workspace.",
  session_required: "Your session expired. Reload the page to start a fresh workspace.",
  sign_in_required: "Please sign in to continue.",
};
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.code || "service_unavailable");
  return data as T;
}
async function loadWorkspace() {
  const session = window.AgentGate
    ? await window.AgentGate.ready
    : await api<SessionInfo>("/api/session");
  const { tickets } = await api<{ tickets: Ticket[] }>("/api/tickets");
  return { session, tickets };
}
function PriorityIcon({ priority, className }: { priority: string; className?: string }) {
  if (priority === "Urgent")
    return (
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded bg-rose-100 text-xs font-bold text-rose-700",
          className,
        )}
      >
        !
      </span>
    );
  if (priority === "High") return <ArrowUp className={cn("size-4 text-orange-600", className)} />;
  if (priority === "Low") return <ArrowDown className={cn("size-4 text-slate-400", className)} />;
  return (
    <span
      className={cn(
        "inline-flex size-4 items-center justify-center font-semibold text-blue-500",
        className,
      )}
    >
      =
    </span>
  );
}
function Status({ value }: { value: string }) {
  const Icon = value === "In progress" ? CircleDot : value === "Backlog" ? CircleDashed : Circle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 whitespace-nowrap text-sm",
        value === "In progress" ? "text-indigo-600" : "text-slate-500",
      )}
    >
      <Icon className="size-4" />
      {value}
    </span>
  );
}
function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-9 items-center justify-center gap-1.5 rounded-lg bg-indigo-500">
        <span className="h-5 w-1.5 rounded-sm bg-white" />
        <span className="h-5 w-1.5 rounded-sm bg-white" />
      </div>
      <div>
        <div className="text-lg font-semibold tracking-tight text-white">
          parallel<span className="text-indigo-400">.</span>
        </div>
        <div className="mt-0.5 text-xs text-slate-400">Research workspace</div>
      </div>
    </div>
  );
}

function EarlyIdentificationNotice() {
  return (
    <aside
      aria-label="Agent policy"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-slate-700"
    >
      <p>AI assistants must identify themselves before opening tickets or preparing changes.</p>
      {/* The policy is a standalone HTML route; navigate without router prefetch. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href="/experiments/v3/agent-policy"
        className="font-medium text-indigo-700 underline underline-offset-4"
      >
        Identify as an assistant
      </a>
    </aside>
  );
}

function AccessDeclarationNotice() {
  return (
    <aside
      aria-label="Access declaration"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-slate-700"
    >
      <p>An access declaration is required before editing tickets.</p>
      {/* The policy is a standalone HTML route; navigate without router prefetch. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href="/experiments/v4/agent-policy"
        className="font-medium text-indigo-700 underline underline-offset-4"
      >
        Complete access declaration
      </a>
    </aside>
  );
}

export function TicketWorkspace({
  selectedKey,
  basePath = "/tickets",
  discoveryVariant,
}: {
  selectedKey?: string;
  basePath?: string;
  discoveryVariant?: DiscoveryVariant;
}) {
  const router = useRouter();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showReset, setShowReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [priority, setPriority] = useState<Priority>("Medium");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const requiresAccessDeclaration = discoveryVariant === "v4";
  const [accessStatus, setAccessStatus] = useState<{ accepted: boolean; sessionId: string } | null>(
    null,
  );
  const accessBlocked =
    requiresAccessDeclaration &&
    (resetting ||
      !session ||
      accessStatus?.sessionId !== session.sessionId ||
      accessStatus.accepted !== true);
  const selected = tickets.find((t) => t.key === selectedKey);
  const openedTicketKey = selected?.key;
  const [editorTicketKey, setEditorTicketKey] = useState(openedTicketKey);

  // Reset the draft before rendering a different ticket, without a stale intermediate render.
  if (editorTicketKey !== openedTicketKey) {
    setEditorTicketKey(openedTicketKey);
    setPriority(selected?.priority ?? "Medium");
    setSaveError("");
    setSaved(false);
  }

  const refresh = useCallback(
    () =>
      loadWorkspace()
        .then((data) => {
          setSession(data.session);
          setTickets(data.tickets);
        })
        .catch((e: unknown) => {
          const code = e instanceof Error ? e.message : "service_unavailable";
          if (code === "sign_in_required") router.replace("/login");
          else setError(code);
        })
        .finally(() => setLoading(false)),
    [router],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!requiresAccessDeclaration) return;
    let cancelled = false;
    let latestRequest = 0;
    async function checkAccess() {
      const request = ++latestRequest;
      try {
        await window.AgentGate?.ready;
        const status = await window.AgentGate?.status();
        if (!cancelled && request === latestRequest) setAccessStatus(status ?? null);
      } catch {
        if (!cancelled && request === latestRequest) setAccessStatus(null);
      }
    }
    void checkAccess();
    const interval = window.setInterval(() => void checkAccess(), 10000);
    window.addEventListener("agentgate:accepted", checkAccess);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("agentgate:accepted", checkAccess);
    };
  }, [requiresAccessDeclaration]);
  useEffect(() => {
    function observe() {
      void window.AgentGate?.track({
        type: "navigation",
        path: openedTicketKey ? `/tickets/${openedTicketKey}` : "/tickets",
      });
      if (openedTicketKey)
        void window.AgentGate?.track({ type: "ticket_open", ticketKey: openedTicketKey });
    }
    observe();
    window.addEventListener("agentgate:accepted", observe);
    return () => window.removeEventListener("agentgate:accepted", observe);
  }, [openedTicketKey]); // Record reads only when the client tracker is enabled.
  const filtered = useMemo(
    () =>
      tickets.filter(
        (t) =>
          `${t.title} ${t.description} ${t.code}`.toLowerCase().includes(query.toLowerCase()) &&
          (priorityFilter === "all" || t.priority === priorityFilter) &&
          (statusFilter === "all" || t.status === statusFilter),
      ),
    [tickets, query, priorityFilter, statusFilter],
  );
  async function save() {
    if (!selected || accessBlocked) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    await window.AgentGate?.track({ type: "save_attempt", ticketKey: selected.key, priority });
    try {
      const result = await api<{
        ticket: { priority: Priority; version: number; updatedAt: string };
      }>(`/api/tickets/${selected.key}/priority`, {
        method: "PATCH",
        body: JSON.stringify({ priority, version: selected.version }),
      });
      setTickets((current) =>
        current.map((t) => (t.key === selected.key ? { ...t, ...result.ticket } : t)),
      );
      setSaved(true);
      await window.AgentGate?.track({
        type: "save_result",
        ticketKey: selected.key,
        outcome: "success",
      });
    } catch (e) {
      const code = e instanceof Error ? e.message : "service_unavailable";
      setSaveError(errorMessages[code] ?? "We couldn't save your change. Please try again.");
      await window.AgentGate?.track({
        type: "save_result",
        ticketKey: selected.key,
        outcome: "blocked",
      });
    } finally {
      setSaving(false);
    }
  }
  async function newRun() {
    setResetting(true);
    if (requiresAccessDeclaration) setAccessStatus(null);
    try {
      await api("/api/runs", { method: "POST", body: JSON.stringify({ taskKey: "northstar" }) });
      await window.AgentGate?.restart();
      setShowReset(false);
      router.push(basePath);
      setError("");
      setLoading(true);
      await refresh();
    } catch {
      setError("service_unavailable");
    } finally {
      setResetting(false);
    }
  }
  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      // Discard the document's cached AgentGate state when ending the account session.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/login");
    } catch {
      setError("logout_failed");
    }
  }
  const nav = (
    <>
      <div className="px-6 pb-10 pt-8">
        <Brand />
      </div>
      <div className="px-4">
        <div className="mb-3 px-3 text-xs font-medium tracking-wider text-slate-500">WORKSPACE</div>
        {[
          { title: "All tickets", icon: Layers2, value: "all" },
          { title: "In progress", icon: CircleDot, value: "In progress" },
          { title: "Backlog", icon: CircleDashed, value: "Backlog" },
        ].map((item) => (
          <button
            key={item.value}
            onClick={() => {
              setStatusFilter(item.value);
              setMobileNav(false);
            }}
            className={cn(
              "mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors",
              statusFilter === item.value
                ? "bg-white/10 font-medium text-white"
                : "text-slate-400 hover:bg-white/5 hover:text-white",
            )}
          >
            <item.icon
              className={cn("size-[18px]", statusFilter === item.value && "text-indigo-300")}
            />
            {item.title}
            <span className="ml-auto text-xs text-slate-400">
              {tickets.filter((t) => item.value === "all" || t.status === item.value).length}
            </span>
          </button>
        ))}
      </div>
      <div className="mx-7 mt-10 border-t border-white/10 pt-5">
        <div className="mb-4 text-xs font-medium tracking-wider text-slate-500">YOUR TEAMS</div>
        <div className="mb-4 flex items-center gap-3 text-sm text-slate-400">
          <span className="size-2 rounded-sm bg-indigo-400" />
          Product
        </div>
        <div className="mb-4 flex items-center gap-3 text-sm text-slate-400">
          <span className="size-2 rounded-sm bg-cyan-400" />
          Platform
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <span className="size-2 rounded-sm bg-amber-400" />
          Security
        </div>
      </div>
      <div className="mt-auto px-5 pb-5">
        <div className="mb-5 rounded-lg border border-white/10 bg-white/5 p-4">
          <FolderKanban className="mb-2 size-5 text-indigo-300" />
          <p className="text-sm font-medium text-slate-200">A little focus goes a long way.</p>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            One workspace. Four tickets.
            <br />
            Keep the next priority clear.
          </p>
        </div>
        <div className="flex items-center gap-3 border-t border-white/10 pt-5">
          <div className="flex size-9 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-slate-200">
            R17
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium text-slate-200">Research participant</div>
            <div className="mt-0.5 text-xs text-slate-500">R17 · Member</div>
          </div>
          <button
            onClick={logout}
            aria-label="Sign out"
            className="rounded-md p-2 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </>
  );
  return (
    <div className="min-h-screen lg:flex">
      <aside className="sidebar-grid fixed inset-y-0 left-0 z-20 hidden w-[238px] flex-col bg-[#171e30] lg:flex">
        {nav}
      </aside>
      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent
          side="left"
          className="flex w-[270px] flex-col gap-0 border-none bg-[#171e30] p-0"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Workspace navigation</SheetTitle>
            <SheetDescription>Filter your tickets by status.</SheetDescription>
          </SheetHeader>
          {nav}
        </SheetContent>
      </Sheet>
      <main className="min-w-0 flex-1 lg:ml-[238px]">
        <header className="flex h-[72px] items-center justify-between border-b bg-white px-5 sm:px-9">
          <div className="flex items-center gap-3 text-sm">
            <button
              onClick={() => setMobileNav(true)}
              aria-label="Open navigation"
              className="mr-1 rounded p-1 lg:hidden"
            >
              <PanelLeft className="size-5" />
            </button>
            <span className="text-slate-400">Workspace</span>
            <span className="text-slate-300">/</span>
            <span className="font-medium">Tickets</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-slate-400 sm:block">Parallel Research</span>
            <div className="flex size-8 items-center justify-center rounded-full border border-indigo-100 bg-indigo-50 text-xs font-semibold text-indigo-600">
              R17
            </div>
          </div>
        </header>
        <div className="mx-auto max-w-[1500px] px-5 pb-10 pt-8 sm:px-9 sm:pt-10">
          {accessBlocked && <AccessDeclarationNotice />}
          {discoveryVariant === "v3" && <EarlyIdentificationNotice />}
          {(discoveryVariant === "v1" || discoveryVariant === "v2") && (
            <aside
              aria-label="Agent policy"
              className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-slate-700"
            >
              <p>AI assistants: identify yourself before making changes</p>
              <a
                href={`/experiments/${discoveryVariant}/agent-policy`}
                className="font-medium text-indigo-700 underline underline-offset-4"
              >
                Read agent policy
              </a>
            </aside>
          )}
          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-3">
                <h1 className="text-[28px] font-semibold tracking-tight sm:text-[30px]">
                  {statusFilter === "all" ? "All tickets" : statusFilter}
                </h1>
                <Badge
                  variant="secondary"
                  className="rounded-md px-2 py-0.5 text-xs text-slate-500"
                >
                  {filtered.length}
                </Badge>
              </div>
              <p className="text-sm leading-relaxed text-slate-500">
                A clear view of the work ahead.
              </p>
            </div>
            <Button
              onClick={() => setShowReset(true)}
              disabled={loading || !!error}
              className="h-10 gap-2 rounded-lg px-4 shadow-sm"
            >
              <Plus className="size-4" />
              New run
            </Button>
          </div>
          <div className="mb-8 grid grid-cols-2 gap-3 xl:grid-cols-4">
            {[
              {
                label: "Total tickets",
                value: tickets.length,
                icon: Layers2,
                color: "bg-indigo-50 text-indigo-500",
              },
              {
                label: "In progress",
                value: tickets.filter((t) => t.status === "In progress").length,
                icon: CircleDot,
                color: "bg-blue-50 text-blue-500",
              },
              {
                label: "High priority",
                value: tickets.filter((t) => ["High", "Urgent"].includes(t.priority)).length,
                icon: ArrowUp,
                color: "bg-orange-50 text-orange-500",
              },
              {
                label: "Read only",
                value: tickets.filter((t) => !t.canEdit).length,
                icon: LockKeyhole,
                color: "bg-slate-100 text-slate-500",
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="flex items-center justify-between rounded-xl border bg-white p-4 sm:p-5"
              >
                <div>
                  <p className="mb-2 text-sm text-slate-500">{stat.label}</p>
                  {loading ? (
                    <Skeleton className="h-8 w-8" />
                  ) : (
                    <p className="text-2xl font-semibold tabular-nums">
                      {stat.value.toString().padStart(2, "0")}
                    </p>
                  )}
                </div>
                <div
                  className={cn("flex size-10 items-center justify-center rounded-xl", stat.color)}
                >
                  <stat.icon className="size-5" />
                </div>
              </div>
            ))}
          </div>
          <section
            aria-label="Tickets"
            className="overflow-hidden rounded-xl border bg-white shadow-[0_2px_8px_#17243b03]"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 pt-5">
              <div className="flex items-center gap-2 border-b-2 border-indigo-500 pb-4 text-sm font-medium text-indigo-600">
                <Columns3 className="size-4" />
                List view
              </div>
              <span className="pb-4 text-xs text-slate-400">Synthetic research tickets</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-b px-4 py-4 sm:px-5">
              <div className="relative min-w-[180px] flex-1 sm:max-w-[320px]">
                <Search className="pointer-events-none absolute left-3 top-3 size-4 text-slate-400" />
                <Input
                  aria-label="Search tickets"
                  placeholder="Search tickets…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-10 border-slate-200 bg-white pl-9 text-sm shadow-none"
                />
              </div>
              <Select value={priorityFilter} onValueChange={setPriorityFilter}>
                <SelectTrigger
                  aria-label="Filter by priority"
                  className="h-10 min-w-[155px] gap-2 bg-white shadow-none"
                >
                  <SlidersHorizontal className="size-4 text-slate-400" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All priorities</SelectItem>
                  {priorities.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(query || priorityFilter !== "all") && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setPriorityFilter("all");
                  }}
                >
                  <X className="size-4" />
                  Clear
                </Button>
              )}
              <span className="ml-auto hidden text-xs text-slate-400 md:block">
                {filtered.length} tickets
              </span>
            </div>
            {loading ? (
              <div className="space-y-6 p-6">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : error ? (
              <div className="px-6 py-14 text-center" role="alert">
                <CircleHelp className="mx-auto mb-4 size-8 text-slate-400" />
                <h2 className="mb-2 text-lg font-semibold">
                  {error === "supabase_not_configured"
                    ? "Connect your workspace"
                    : "We couldn't load your workspace"}
                </h2>
                <p className="mx-auto mb-5 max-w-lg text-sm leading-6 text-slate-500">
                  {error === "supabase_not_configured"
                    ? "Supabase needs to be configured before you can sign in and save tickets. Follow the project README to connect your database."
                    : "Please check your connection and try again. Your saved work has not been changed."}
                </p>
                <Button variant="outline" onClick={() => window.location.reload()}>
                  Try again
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-16 text-center">
                <Search className="mx-auto mb-4 size-7 text-slate-300" />
                <h2 className="font-medium">No tickets found</h2>
                <p className="mt-2 text-sm text-slate-500">
                  Try a different search or clear your filters.
                </p>
                <Button
                  variant="ghost"
                  className="mt-4"
                  onClick={() => {
                    setQuery("");
                    setPriorityFilter("all");
                    setStatusFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50/70 hover:bg-slate-50/70">
                    <TableHead className="w-[47%] py-3 pl-5 text-xs font-medium text-slate-500">
                      Ticket
                    </TableHead>
                    <TableHead className="text-xs font-medium text-slate-500">Status</TableHead>
                    <TableHead className="text-xs font-medium text-slate-500">Priority</TableHead>
                    <TableHead className="hidden text-xs font-medium text-slate-500 xl:table-cell">
                      Assignee
                    </TableHead>
                    <TableHead className="pr-5 text-right text-xs font-medium text-slate-500">
                      Team
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((ticket) => (
                    <TableRow key={ticket.key} className="ticket-row">
                      <TableCell className="py-5 pl-5">
                        <Link
                          href={`${basePath}/${ticket.key}`}
                          className="group block min-w-[230px] rounded-sm focus-visible:outline-2 focus-visible:outline-indigo-500"
                        >
                          <div className="mb-1.5 flex items-center gap-3">
                            <span className="text-xs tabular-nums text-slate-400">
                              {ticket.code}
                            </span>
                            <span className="font-medium group-hover:text-indigo-600">
                              {ticket.title}
                            </span>
                            {!ticket.canEdit && (
                              <LockKeyhole
                                aria-label="Read only"
                                className="size-3.5 text-slate-400"
                              />
                            )}
                          </div>
                          <p className="max-w-[350px] truncate text-sm text-slate-500">
                            {ticket.description}
                          </p>
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Status value={ticket.status} />
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2 text-sm text-slate-600">
                          <PriorityIcon priority={ticket.priority} />
                          {ticket.priority}
                        </span>
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        <span
                          title={ticket.assignee}
                          className="inline-flex size-8 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-xs font-medium text-slate-500"
                        >
                          {ticket.initials}
                        </span>
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        <Badge
                          variant="outline"
                          className="border-slate-200 bg-white text-xs font-normal text-slate-500"
                        >
                          {ticket.team}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="flex items-center justify-between border-t px-5 py-4 text-xs text-slate-400">
              <span>
                {!loading && !error
                  ? `Showing ${filtered.length} of ${tickets.length} tickets`
                  : "Workspace"}
              </span>
              <span className="flex items-center gap-1.5">
                <LockKeyhole className="size-3" />
                Private workspace
              </span>
            </div>
          </section>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
            <span>Open a ticket to review its details and update its priority.</span>
            <span>
              {session?.fixtureMode
                ? "Local fixture mode · not connected to Supabase"
                : "Changes are saved to your current run."}
            </span>
          </div>
        </div>
      </main>
      <Sheet
        open={!!selectedKey}
        onOpenChange={(open) => {
          if (!open) router.push(basePath);
        }}
      >
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-[530px]">
          <SheetHeader className="border-b px-7 pb-6 pt-8">
            <div className="mb-4 flex items-center gap-2 text-xs text-slate-400">
              <Layers2 className="size-3.5" />
              <span>Tickets</span>
              <span>/</span>
              <span>{selected?.code ?? "…"}</span>
            </div>
            <SheetTitle className="text-2xl tracking-tight">
              {selected?.title ?? (loading ? "Loading ticket…" : "Ticket not found")}
            </SheetTitle>
            <SheetDescription className="mt-1 text-sm leading-relaxed">
              {selected?.description ?? ""}
            </SheetDescription>
          </SheetHeader>
          {selected && (
            <>
              <div className="flex-1 overflow-y-auto px-7 py-7">
                {accessBlocked && <AccessDeclarationNotice />}
                {discoveryVariant === "v3" && <EarlyIdentificationNotice />}
                <div className="mb-8 flex items-center gap-3">
                  <Status value={selected.status} />
                  <span className="text-slate-200">|</span>
                  <Badge variant="secondary" className="font-normal">
                    {selected.label}
                  </Badge>
                </div>
                <h2 className="mb-3 text-sm font-semibold">Description</h2>
                <p className="mb-9 text-sm leading-7 text-slate-500">{selected.body}</p>
                <h2 className="mb-5 border-b pb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Properties
                </h2>
                <dl className="space-y-6 text-sm">
                  <div className="grid grid-cols-[110px_1fr] items-center gap-3">
                    <dt className="text-slate-500">Priority</dt>
                    <dd>
                      <Select
                        value={priority}
                        disabled={!selected.canEdit || saving || accessBlocked}
                        onValueChange={(value) => {
                          setPriority(value as Priority);
                          setSaved(false);
                          void window.AgentGate?.track({
                            type: "priority_change",
                            ticketKey: selected.key,
                            priority: value as Priority,
                          });
                        }}
                      >
                        <SelectTrigger
                          aria-label="Ticket priority"
                          className="w-full bg-white shadow-none"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {priorities.map((p) => (
                            <SelectItem key={p} value={p}>
                              <span className="flex items-center gap-2">
                                <PriorityIcon priority={p} />
                                {p}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </dd>
                  </div>
                  <div className="grid grid-cols-[110px_1fr] items-center gap-3">
                    <dt className="text-slate-500">Assignee</dt>
                    <dd className="flex items-center gap-2">
                      <span className="flex size-7 items-center justify-center rounded-full bg-indigo-50 text-xs text-indigo-600">
                        {selected.initials}
                      </span>
                      {selected.assignee}
                    </dd>
                  </div>
                  <div className="grid grid-cols-[110px_1fr] items-center gap-3">
                    <dt className="text-slate-500">Team</dt>
                    <dd>{selected.team}</dd>
                  </div>
                  <div className="grid grid-cols-[110px_1fr] items-center gap-3">
                    <dt className="text-slate-500">Last updated</dt>
                    <dd className="text-slate-600">
                      {new Date(selected.updatedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </dd>
                  </div>
                </dl>
                {!selected.canEdit && (
                  <div className="mt-8 flex items-start gap-3 rounded-lg border bg-slate-50 p-4 text-sm leading-6 text-slate-500">
                    <LockKeyhole className="mt-1 size-4 shrink-0" />
                    <p>You can view this ticket. Changes are restricted to the Security team.</p>
                  </div>
                )}
              </div>
              <div className="border-t bg-slate-50/50 p-6">
                {saveError && (
                  <p
                    role="alert"
                    className="mb-4 rounded-md bg-rose-50 p-3 text-sm leading-6 text-rose-700"
                  >
                    {saveError}
                  </p>
                )}
                <div className="flex items-center justify-between gap-4">
                  <span role="status" className="flex items-center gap-2 text-sm text-slate-500">
                    {saved ? (
                      <>
                        <Check className="size-4 text-emerald-600" />
                        Changes saved
                      </>
                    ) : priority !== selected.priority ? (
                      "Unsaved changes"
                    ) : (
                      "Up to date"
                    )}
                  </span>
                  <Button
                    onClick={save}
                    disabled={
                      saving || !selected.canEdit || priority === selected.priority || accessBlocked
                    }
                    className="min-w-[132px]"
                  >
                    {saving && <Loader2 className="size-4 animate-spin" />}
                    {saving ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
      <AlertDialog open={showReset} onOpenChange={setShowReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a fresh run?</AlertDialogTitle>
            <AlertDialogDescription>
              This creates a new workspace with the original four tickets. Your current run will
              close, and its saved results will remain in the research record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>Keep current run</AlertDialogCancel>
            <AlertDialogAction
              disabled={resetting}
              onClick={(e) => {
                e.preventDefault();
                void newRun();
              }}
            >
              {resetting ? "Creating…" : "Start new run"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
