import { TicketWorkspace } from "@/components/ticket-workspace";
export default async function TicketPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <TicketWorkspace selectedKey={key} />;
}
