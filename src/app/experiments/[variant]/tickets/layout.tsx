import { notFound } from "next/navigation";
import { isDiscoveryVariant, serializeInlineJson } from "@/lib/research/discovery-variant";
import { agentPolicy } from "@/lib/research/policy";

export default async function DiscoveryTicketsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ variant: string }>;
}) {
  const { variant } = await params;
  if (!isDiscoveryVariant(variant)) notFound();
  return (
    <>
      {variant === "h1" && (
        <script
          id="agent-policy"
          type="application/json"
          dangerouslySetInnerHTML={{ __html: serializeInlineJson(agentPolicy) }}
        />
      )}
      {children}
    </>
  );
}
