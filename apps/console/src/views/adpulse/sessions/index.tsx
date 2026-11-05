import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { createConsoleClient } from "../../../adpulse-client";

const client = createConsoleClient(
  import.meta.env.VITE_API_BASE_URL ?? "",
  import.meta.env.VITE_CONSOLE_TOKEN ?? "",
);

export default function SessionsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const result = await client.GET("/api/sessions");
      if (!result.data) throw new Error(JSON.stringify(result.error));
      return result.data.items;
    },
  });

  if (isLoading) return <div className="p-6">加载中…</div>;
  if (error) return <div className="p-6 text-red-500">{String(error)}</div>;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">决策会话</h1>
      <div className="grid gap-4 md:grid-cols-2">
        {data?.map((session: any) => (
          <Card key={session.id}>
            <CardHeader>
              <CardTitle>{session.signal.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{session.signal.summary}</p>
              <p className="text-xs mt-2">状态：{session.status} · 轮次：{session.roundNo}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
