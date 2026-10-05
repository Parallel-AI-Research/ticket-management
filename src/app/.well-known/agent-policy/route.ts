import { agentPolicy } from "@/lib/research/policy";
export function GET() {
  return Response.json(agentPolicy);
}
