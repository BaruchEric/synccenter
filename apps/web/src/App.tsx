import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthGate } from "@/components/AuthGate";
import { Layout } from "@/components/Layout";
import { Dashboard } from "@/routes/Dashboard";
import { Folders } from "@/routes/Folders";
import { FolderDetail } from "@/routes/FolderDetail";
import { Rules } from "@/routes/Rules";
import { Hosts } from "@/routes/Hosts";
import { Conflicts } from "@/routes/Conflicts";

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthGate>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="folders" element={<Folders />} />
              <Route path="folders/:name" element={<FolderDetail />} />
              <Route path="rules" element={<Rules />} />
              <Route path="hosts" element={<Hosts />} />
              <Route path="conflicts" element={<Conflicts />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthGate>
    </QueryClientProvider>
  );
}
