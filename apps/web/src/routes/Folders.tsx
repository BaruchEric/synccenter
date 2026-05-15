import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type FoldersList } from "@/lib/api";
import { Card } from "@/components/Card";

export function Folders() {
  const q = useQuery({ queryKey: ["folders"], queryFn: () => api.get<FoldersList>("/folders") });

  if (q.isLoading) return <div className="text-slate-500">Loading folders…</div>;
  if (q.isError) return <div className="text-error">{(q.error as Error).message}</div>;

  const items = q.data?.folders ?? [];
  return (
    <Card title={`Folders (${items.length})`}>
      {items.length === 0 ? (
        <div className="text-slate-500">No folders defined.</div>
      ) : (
        <ul className="divide-y divide-slate-800">
          {items.map((name) => (
            <li key={name} className="flex items-center justify-between py-2">
              <Link to={`/folders/${encodeURIComponent(name)}`} className="text-blue-400 hover:underline">
                {name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
