import { discoveryHtml, renderDiscoveryPolicyPage } from "@/lib/research/discovery-form";
import { withAgentRequestLog } from "@/lib/research/request-log";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ variant: string }> }) {
  return withAgentRequestLog(request, async (setResult) => {
    const { variant } = await params;
    if (variant !== "v1" && variant !== "v2") return new Response(null, { status: 404 });
    setResult("policy_served");
    // Query parameters never assert acceptance. Only the actual POST result can do that.
    return discoveryHtml(renderDiscoveryPolicyPage(variant));
  });
}
