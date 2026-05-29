import { Layout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import Models from "@/pages/models";
import NotFound from "@/pages/not-found";
import Quickstart from "@/pages/quickstart";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { Route, Switch, Router as WouterRouter } from "wouter";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/models" component={Models} />
        <Route path="/quickstart" component={Quickstart} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Router />
      </WouterRouter>
      <Toaster theme="dark" position="bottom-right" />
    </QueryClientProvider>
  );
}

export default App;
