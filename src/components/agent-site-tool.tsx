"use client";

import { useEffect } from "react";
import { publishDeclarationTool, type SiteModelContext } from "@/lib/research/webmcp";

export function AgentSiteTool() {
  useEffect(() => {
    const context = (document as Document & { modelContext?: SiteModelContext }).modelContext;
    if (typeof context?.registerTool !== "function") return;
    const publication = publishDeclarationTool(
      context,
      () => window.AgentGate,
      () => /^\/experiments\/w1\/tickets(?:\/|$)/.test(window.location.pathname),
    );
    publication.ready.catch(() => {
      // A discovery failure must not fabricate acceptance or break the ordinary app.
      console.warn("agent_site_tool_publication_failed");
    });
    return publication.dispose;
  }, []);
  return null;
}
