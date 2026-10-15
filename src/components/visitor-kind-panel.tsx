"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";

const choiceSchema = z.enum(["ai_assistant", "person", "prefer_not_to_say"]);
type Choice = z.infer<typeof choiceSchema>;
const labels: Record<Choice, string> = {
  ai_assistant: "AI assistant",
  person: "Person",
  prefer_not_to_say: "Prefer not to say",
};
const responseSchema = z.object({
  sessionId: z.uuid(),
  variant: z.enum(["v5", "v6"]),
  accepted: z.boolean(),
  choice: choiceSchema.nullable(),
  eventId: z.uuid().nullable(),
});
const statusSchema = responseSchema.refine((value) =>
  value.accepted
    ? value.choice !== null && value.eventId !== null
    : value.choice === null && value.eventId === null,
);
const acceptedSchema = responseSchema.extend({
  accepted: z.literal(true),
  choice: choiceSchema,
  eventId: z.uuid(),
});

export function VisitorKindPanel({
  variant,
  sessionId,
  onRecorded,
}: {
  variant: "v5" | "v6";
  sessionId: string;
  onRecorded: (value: { sessionId: string; variant: "v5" | "v6"; choice: Choice }) => void;
}) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);

  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void fetch(`/api/visitor-kind?variant=${variant}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error("status_failed");
        const status = statusSchema.parse(await response.json());
        if (status.sessionId !== sessionId || status.variant !== variant)
          throw Error("session_changed");
        if (controller.signal.aborted) return;
        setChoice(status.choice);
        setReady(true);
        if (status.choice && status.eventId)
          onRecorded({ sessionId, variant, choice: status.choice });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not check this session. Reload the page to try again.");
      });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, [sessionId, variant, onRecorded]);

  async function record(value: Choice) {
    if (!ready || busy || !active.current) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/visitor-kind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, variant, choice: value }),
      });
      if (!response.ok) throw Error("submission_failed");
      const result = acceptedSchema.parse(await response.json());
      if (result.sessionId !== sessionId || result.variant !== variant || result.choice !== value)
        throw Error("session_changed");
      if (!active.current) return;
      setChoice(value);
      onRecorded({ sessionId, variant, choice: value });
    } catch {
      if (active.current) setError("Your choice was not confirmed. Please try again.");
    } finally {
      if (active.current) setBusy(false);
    }
  }

  return (
    <aside
      aria-label="How you are using this workspace"
      className="mb-6 rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-sm"
    >
      <p className="font-semibold text-slate-800">How are you using this workspace?</p>
      <p className="mt-2 leading-5 text-slate-600">
        Clicking an option records that choice for this session. No model name, user details or
        conversation content is requested.
      </p>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        {variant === "v6"
          ? "Choose any option to enable editing. You may prefer not to say."
          : "Answering is optional. You can edit without answering."}
      </p>
      {choice ? (
        <p role="status" className="mt-3 font-medium text-indigo-800">
          Recorded: {labels[choice]}.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(labels) as Choice[]).map((value) => (
            <Button
              key={value}
              variant="outline"
              size="sm"
              disabled={!ready || busy}
              onClick={() => void record(value)}
            >
              {labels[value]}
            </Button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-rose-700">
          {error}
        </p>
      )}
    </aside>
  );
}
