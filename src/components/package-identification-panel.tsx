"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AgentIdentification } from "@parallel-research/agent-identification/react";
import type { RecordedDeclaration } from "@parallel-research/agent-identification";
import { z } from "zod";
import { Button } from "@/components/ui/button";

export type PackageMode = "optional" | "required";
const modeSchema = z.enum(["optional", "required"]);
const contextSchema = z.object({
  sessionId: z.uuid(),
  mode: modeSchema,
  siteId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  apiUrl: z.url(),
  bindingContext: z.string().min(1).max(8192),
  expiresAt: z.iso.datetime(),
});
const acknowledgmentSchema = z.object({
  sessionId: z.uuid(),
  mode: modeSchema,
  choice: z.enum(["ai_assistant", "person", "prefer_not_to_say"]),
  collectorSessionId: z.uuid(),
  collectorEventId: z.uuid(),
  expiresAt: z.iso.datetime(),
  evidence: z.literal("self_reported"),
});
type BindingContext = z.infer<typeof contextSchema>;
export type PackageAcknowledgment = z.infer<typeof acknowledgmentSchema> & { receipt: string };

// Keep the exact signed context: the package includes it in its collector-session storage key.
// Memory also preserves it across drawer remounts when sessionStorage is unavailable.
const contexts = new Map<string, BindingContext>();
function cacheKey(sessionId: string, mode: PackageMode) {
  return `parallel-ticket-identification-context:v1:${sessionId}:${mode}`;
}
function cacheContext(key: string, value: BindingContext | null) {
  if (value) contexts.set(key, value);
  else contexts.delete(key);
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    // A blocked browser store does not prevent the current page from working.
  }
}
function readContext(sessionId: string, mode: PackageMode): BindingContext | null {
  const key = cacheKey(sessionId, mode);
  let value: unknown = contexts.get(key);
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) value = JSON.parse(stored);
  } catch {
    // Use the current page's memory cache when browser storage is unavailable.
  }
  const result = contextSchema.safeParse(value);
  if (
    result.success &&
    result.data.sessionId === sessionId &&
    result.data.mode === mode &&
    Date.parse(result.data.expiresAt) > Date.now()
  ) {
    return result.data;
  }
  cacheContext(key, null);
  return null;
}

export function PackageIdentificationPanel({
  sessionId,
  mode,
  onRecorded,
}: {
  sessionId: string;
  mode: PackageMode;
  onRecorded: (value: PackageAcknowledgment | null) => void;
}) {
  const [configuration, setConfiguration] = useState<BindingContext | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<RecordedDeclaration | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const active = useRef(false);
  const generation = useRef(0);
  const confirmationRequest = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const configurationRef = useRef<BindingContext | null>(null);

  const getContext = useCallback(async () => {
    const currentGeneration = generation.current;
    const cached = readContext(sessionId, mode);
    if (cached) return cached;
    const response = await fetch("/api/package-identification/context", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, mode }),
      signal: AbortSignal.any([
        ...(operation.current ? [operation.current.signal] : []),
        AbortSignal.timeout(15_000),
      ]),
    });
    if (!response.ok) throw new Error("context_unavailable");
    const context = contextSchema.parse(await response.json());
    if (
      context.sessionId !== sessionId ||
      context.mode !== mode ||
      Date.parse(context.expiresAt) <= Date.now() ||
      !active.current ||
      generation.current !== currentGeneration
    ) {
      throw new Error("context_changed");
    }
    cacheContext(cacheKey(sessionId, mode), context);
    return context;
  }, [sessionId, mode]);

  useEffect(() => {
    active.current = true;
    generation.current += 1;
    const currentGeneration = generation.current;
    operation.current = new AbortController();
    void getContext()
      .then((context) => {
        if (!active.current || generation.current !== currentGeneration) return;
        configurationRef.current = context;
        setConfiguration(context);
        setError("");
      })
      .catch(() => {
        if (!active.current || generation.current !== currentGeneration) return;
        onRecorded(null);
        setError("Visitor identification is unavailable. Please try again.");
      });
    return () => {
      active.current = false;
      generation.current += 1;
      operation.current?.abort();
    };
  }, [getContext, loadAttempt, onRecorded]);

  const bindingContext = useCallback(async () => {
    const context = await getContext();
    const current = configurationRef.current;
    if (
      !active.current ||
      !current ||
      current.siteId !== context.siteId ||
      current.apiUrl !== context.apiUrl
    ) {
      throw new Error("The workspace changed. Reload the page to continue.");
    }
    return context.bindingContext;
  }, [getContext]);

  const confirm = useCallback(
    async (declaration: RecordedDeclaration) => {
      if (!active.current) return;
      const currentGeneration = generation.current;
      const request = ++confirmationRequest.current;
      onRecorded(null);
      setConfirming(true);
      setPending(declaration);
      setError("");
      try {
        const response = await fetch("/api/package-identification/receipt", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, mode, receipt: declaration.receipt }),
          signal: AbortSignal.any([
            ...(operation.current ? [operation.current.signal] : []),
            AbortSignal.timeout(15_000),
          ]),
        });
        if (!response.ok) throw new Error("confirmation_unavailable");
        const result = acknowledgmentSchema.parse(await response.json());
        if (
          result.sessionId !== sessionId ||
          result.mode !== mode ||
          result.choice !== declaration.choice ||
          result.collectorSessionId !== declaration.sessionId ||
          result.collectorEventId !== declaration.eventId ||
          Date.parse(result.expiresAt) <= Date.now() ||
          Date.parse(result.expiresAt) > Date.parse(declaration.expiresAt)
        ) {
          throw new Error("confirmation_changed");
        }
        if (
          !active.current ||
          generation.current !== currentGeneration ||
          confirmationRequest.current !== request
        ) {
          return;
        }
        onRecorded({ ...result, receipt: declaration.receipt });
        setPending(null);
      } catch {
        if (
          active.current &&
          generation.current === currentGeneration &&
          confirmationRequest.current === request
        ) {
          onRecorded(null);
          setError("Your choice could not be confirmed for this workspace. Please try again.");
        }
      } finally {
        if (
          active.current &&
          generation.current === currentGeneration &&
          confirmationRequest.current === request
        ) {
          setConfirming(false);
        }
      }
    },
    [sessionId, mode, onRecorded],
  );
  const handleRecorded = useCallback(
    (declaration: RecordedDeclaration) => {
      void confirm(declaration);
    },
    [confirm],
  );
  const handleError = useCallback(() => {
    if (!active.current) return;
    confirmationRequest.current += 1;
    setConfirming(false);
    setPending(null);
    onRecorded(null);
    // The package owns its error and Retry UI, including clearing it after recovery.
    setError("");
  }, [onRecorded]);

  return (
    <div className="mb-6">
      {configuration ? (
        <AgentIdentification
          apiUrl={configuration.apiUrl}
          siteId={configuration.siteId}
          mode={mode}
          storage="session"
          bindingContext={bindingContext}
          onRecorded={handleRecorded}
          onError={handleError}
        />
      ) : !error ? (
        <p role="status" className="text-sm text-slate-500">
          Loading visitor identification…
        </p>
      ) : null}
      {confirming && (
        <p role="status" className="mt-3 text-sm text-slate-500">
          Confirming your choice…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {error}
        </p>
      )}
      {error && !configuration && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => setLoadAttempt((value) => value + 1)}
        >
          Retry
        </Button>
      )}
      {error && pending && !confirming && (
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void confirm(pending)}>
          Retry confirmation
        </Button>
      )}
    </div>
  );
}
