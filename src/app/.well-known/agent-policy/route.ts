import { agentPolicy } from "@/lib/research/policy";
import { withAgentRequestLog } from "@/lib/research/request-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler(request: Request) {
  return withAgentRequestLog(request, (setResult) => {
    if (request.method === "OPTIONS") {
      setResult("options");
      return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS" } });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      setResult("method_not_allowed");
      return new Response(null, { status: 405 });
    }
    setResult("policy_served");
    return Response.json(agentPolicy);
  });
}
export {
  handler as GET,
  handler as HEAD,
  handler as OPTIONS,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
