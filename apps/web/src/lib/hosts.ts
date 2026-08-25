import { useQueries, useQuery } from "@tanstack/react-query";
import { api, type FolderManifest, type HostManifest, type HostsList } from "@/lib/api";

/**
 * Which hosts are rclone members (Google Drive and the like), read from the
 * host manifests themselves.
 *
 * The folder list used to learn this from `/schedule`, which meant a folder
 * only showed its cloud actions when the server could plan a crontab — and
 * on the deployed API it could not, so every folder read "local mesh only"
 * and the bisync button never appeared. A host's engine is a fact about the
 * host; it does not need a schedule to be true.
 */
export function useRcloneHosts(): { rclone: Set<string>; syncthing: string[]; ready: boolean } {
  const list = useQuery({ queryKey: ["hosts"], queryFn: () => api.get<HostsList>("/hosts") });
  const names = list.data?.hosts ?? [];
  const manifests = useQueries({
    queries: names.map((name) => ({
      queryKey: ["host", name],
      queryFn: () => api.get<HostManifest>(`/hosts/${encodeURIComponent(name)}`),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const rclone = new Set<string>();
  const syncthing: string[] = [];
  manifests.forEach((q, i) => {
    const name = names[i];
    if (!name || !q.data) return;
    if (q.data.engine === "rclone") rclone.add(name);
    else syncthing.push(name);
  });
  return {
    rclone,
    syncthing,
    ready: list.isSuccess && manifests.every((q) => q.isSuccess || q.isError),
  };
}

/** The rclone members of one folder, given the set of rclone hosts. */
export function cloudMembers(m: FolderManifest | undefined, rclone: Set<string>): string[] {
  return m ? Object.keys(m.paths ?? {}).filter((h) => rclone.has(h)) : [];
}
