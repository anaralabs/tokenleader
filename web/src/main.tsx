import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

// staleTime keeps range-pill/focus revisits and window refocus from
// re-firing the expensive /stats endpoints within the server's own cache
// TTL; retry 1 (not the default 3) so an overloaded server isn't hit with
// 4x request storms. Admin mutations still refresh instantly — they use
// invalidateQueries, which refetches regardless of staleTime.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
  },
});
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
