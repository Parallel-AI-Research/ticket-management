import { notFound } from "next/navigation";
import {
  inlineDiscoveryPolicy,
  isDiscoveryVariant,
  serializeInlineJson,
} from "@/lib/research/discovery-variant";

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
      {(variant === "h1" || variant === "h2") && (
        <script
          id="agent-policy"
          type="application/json"
          dangerouslySetInnerHTML={{ __html: serializeInlineJson(inlineDiscoveryPolicy(variant)) }}
        />
      )}
      {children}
    </>
  );
}
