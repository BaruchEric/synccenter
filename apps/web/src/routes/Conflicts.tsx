import { useQuery } from "@tanstack/react-query";
import { api, type ConflictsList } from "@/lib/api";
import { Card } from "@/components/Card";

export function Conflicts() {
  const q = useQuery({ queryKey: ["conflicts"], queryFn: () => api.get<ConflictsList>("/conflicts") });
  return (
    <Card title={`Unresolved conflicts (${q.data?.conflicts.length ?? "…"})`}>
      {q.data && q.data.conflicts.length === 0 ? (
        <div className="text-slate-500">All clear.</div>
      ) : q.data ? (
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="py-2">folder</th>
              <th className="py-2">path</th>
              <th className="py-2">detected</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {q.data.conflicts.map((c) => (
              <tr key={c.id} className="border-t border-slate-800">
                <td className="py-2">{c.folder}</td>
                <td className="py-2">{c.path}</td>
                <td className="py-2 text-slate-500">{c.detected_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="text-slate-500">…</div>
      )}
    </Card>
  );
}
