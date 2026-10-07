import { notFound } from "next/navigation";
import { TicketWorkspace } from "@/components/ticket-workspace";
import { isDiscoveryVariant } from "@/lib/research/discovery-variant";

export default async function DiscoveryTicketPage({
  params,
}: {
  params: Promise<{ variant: string; key: string }>;
}) {
  const { variant, key } = await params;
  if (!isDiscoveryVariant(variant)) notFound();
  return (
    <TicketWorkspace
      selectedKey={key}
      basePath={`/experiments/${variant}/tickets`}
      discoveryVariant={variant}
    />
  );
}
