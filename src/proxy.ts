import { createServerClient } from "@supabase/ssr";
import { reportSignedRequest } from "@parallel-research/agent-identification/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

/** Web Bot Auth: the collector checks signed requests. Unsigned ones make no call. */
function reportSignature(request: NextRequest, event: NextFetchEvent) {
  const apiUrl = process.env.AGENT_ID_API_URL;
  const siteId = process.env.AGENT_ID_SITE_ID;
  const secret = process.env.AGENT_ID_SITE_SECRET;
  if (!apiUrl || !siteId || !secret) return;
  // Agents sign the host they asked for, but Next can rewrite the URL's host (to localhost in
  // development). The collector still checks the host against the site's origins.
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host) url.host = host;
  event.waitUntil(reportSignedRequest(request, { apiUrl, siteId, secret, url: url.href }));
}

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  reportSignature(request, event);
  let response = NextResponse.next({ request });
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
    return response;
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookieOptions: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(values, headers) {
          values.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
        },
      },
    },
  );
  await supabase.auth.getClaims();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = {
  matcher: [
    "/tickets/:path*",
    "/experiments/:variant/tickets/:path*",
    "/experiments/:variant/agent-policy",
    "/login",
  ],
};
