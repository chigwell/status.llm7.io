import { RealtimePingDashboard } from "./components/RealtimePingDashboard";

const endpoint =
  import.meta.env.VITE_LLM7_PING_ENDPOINT ??
  (import.meta.env.DEV ? "/llm7-ping/ping" : "/api/ping");

export default function App() {
  return (
    <main className="landing-page">
      <RealtimePingDashboard
        endpoint={endpoint}
        intervalMs={250}
        renderIntervalMs={1000}
        maxPoints={240}
        chartPointLimit={120}
        requestTimeoutMs={6000}
        pollWhenHidden={false}
        visibleModelLimit={10}
        theme="dark"
        title="LLM7 live system status"
        subtitle="See current API health at a glance: which models are available, how quickly they respond, and how much traffic is flowing right now."
      />
    </main>
  );
}
