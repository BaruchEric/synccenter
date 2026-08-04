import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/components/AuthGate";
import { Layout } from "@/components/Layout";
import { Dashboard } from "@/routes/Dashboard";
import { Activity } from "@/routes/Activity";
import { Folders } from "@/routes/Folders";
import { FolderDetail } from "@/routes/FolderDetail";
import { FolderEdit } from "@/routes/FolderEdit";
import { Rules } from "@/routes/Rules";
import { Hosts } from "@/routes/Hosts";
import { Conflicts } from "@/routes/Conflicts";
import { LiveProvider } from "@/lib/live";

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthGate>
        {/* Opt into the v7 behaviours now — without these flags react-router
            logs a deprecation warning per flag on every mount. */}
        <LiveProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="activity" element={<Activity />} />
              <Route path="folders" element={<Folders />} />
              {/* Before the :name route, or "new" is read as a folder name. */}
              <Route path="folders/new" element={<FolderEdit />} />
              <Route path="folders/:name" element={<FolderDetail />} />
              <Route path="folders/:name/edit" element={<FolderEdit />} />
              <Route path="rules" element={<Rules />} />
              <Route path="hosts" element={<Hosts />} />
              <Route path="conflicts" element={<Conflicts />} />
            </Route>
          </Routes>
        </BrowserRouter>
        </LiveProvider>
      </AuthGate>
    </QueryClientProvider>
  );
}
