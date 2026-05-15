import { useQuery } from "@tanstack/react-query";
import { api, type RulesList } from "@/lib/api";
import { Card } from "@/components/Card";

export function Rules() {
  const q = useQuery({ queryKey: ["rules"], queryFn: () => api.get<RulesList>("/rules") });
  return (
    <Card title={`Rulesets (${q.data?.rules.length ?? "…"})`}>
      {q.data ? (
        <ul className="space-y-1 font-mono text-sm">
          {q.data.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : (
        <div className="text-slate-500">…</div>
      )}
    </Card>
  );
}
