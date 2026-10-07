import { notFound } from "next/navigation";
import { TicketWorkspace } from "@/components/ticket-workspace";
import { isDiscoveryVariant } from "@/lib/research/discovery-variant";

export default async function DiscoveryTicketsPage({
  params,
}: {
  params: Promise<{ variant: string }>;
}) {
  const { variant } = await params;
  if (!isDiscoveryVariant(variant)) notFound();
  return (
    <TicketWorkspace basePath={`/experiments/${variant}/tickets`} discoveryVariant={variant} />
  );
}
