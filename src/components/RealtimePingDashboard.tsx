import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./RealtimePingDashboard.css";

export type PingErrors = {
  total: number;
  "4xx": number;
  "5xx": number;
  timeouts: number;
};

export type PingTokens = {
  input: number;
  output: number;
};

export type PingResponseTime = {
  average_seconds: number;
  samples: number;
};

export type PingHealth = {
  attempts: number;
  error_rate: number;
  routing_healthy: boolean;
};

export type ModelMetrics = {
  success_200: number;
  errors: PingErrors;
  tokens: PingTokens;
  response_time: PingResponseTime;
  health: PingHealth;
};

export type PingResponse = {
  message: string;
  active_requests_last_60s: number;
  model_metrics_last_60s: Record<string, ModelMetrics>;
};

export type ModelSnapshot = {
  model: string;
  shortModel: string;
  success200: number;
  errorsTotal: number;
  errors4xx: number;
  errors5xx: number;
  timeouts: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalRequests: number;
  successRate: number;
  errorRate: number;
  timeoutRate: number;
  averageResponseTimeSeconds: number;
  responseTimeSamples: number;
  attempts: number;
  availability: number;
  routingHealthy: boolean;
};

export type PingSnapshot = {
  id: number;
  collectedAt: number;
  timeLabel: string;
  activeRequestsLast60s: number;
  success200: number;
  errorsTotal: number;
  errors4xx: number;
  errors5xx: number;
  timeouts: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalRequests: number;
  successRate: number;
  errorRate: number;
  timeoutRate: number;
  averageResponseTimeSeconds: number;
  averageAvailability: number;
  activeModelCount: number;
  tokensPerSecond: number;
  modelCount: number;
  models: ModelSnapshot[];
};

export type UseRealtimePingMetricsOptions = {
  endpoint?: string;
  intervalMs?: number;
  renderIntervalMs?: number;
  maxPoints?: number;
  requestTimeoutMs?: number;
  pollWhenHidden?: boolean;
  fetchInit?: Omit<RequestInit, "method" | "body" | "signal">;
  onSample?: (sample: PingSnapshot, raw: PingResponse) => void;
  onError?: (error: Error) => void;
};

export type UseRealtimePingMetricsResult = {
  history: PingSnapshot[];
  latest: PingSnapshot | null;
  latestRaw: PingResponse | null;
  error: string | null;
  failuresInRow: number;
  isRunning: boolean;
  start: () => void;
  stop: () => void;
  clearHistory: () => void;
};

export type RealtimePingDashboardProps = UseRealtimePingMetricsOptions & {
  title?: string;
  subtitle?: string;
  className?: string;
  theme?: "dark" | "light";
  visibleModelLimit?: number;
  chartPointLimit?: number;
};

const DEFAULT_ENDPOINT = "https://api.llm7.io/ping";
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_RENDER_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POINTS = 240;
const DEFAULT_REQUEST_TIMEOUT_MS = 6_000;
const DEFAULT_CHART_POINT_LIMIT = 120;

const metricLabels: Record<string, string> = {
  activeRequestsLast60s: "Active requests",
  success200: "HTTP 200",
  errorsTotal: "Errors",
  errors4xx: "4xx",
  errors5xx: "5xx",
  timeouts: "Timeouts",
  averageAvailability: "Availability",
  averageResponseTimeSeconds: "Avg response time",
  inputTokens: "Input tokens",
  outputTokens: "Output tokens",
  totalTokens: "Total tokens",
};

export function useRealtimePingMetrics({
  endpoint = DEFAULT_ENDPOINT,
  intervalMs = DEFAULT_INTERVAL_MS,
  renderIntervalMs = DEFAULT_RENDER_INTERVAL_MS,
  maxPoints = DEFAULT_MAX_POINTS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  pollWhenHidden = false,
  fetchInit,
  onSample,
  onError,
}: UseRealtimePingMetricsOptions = {}): UseRealtimePingMetricsResult {
  const [history, setHistory] = useState<PingSnapshot[]>([]);
  const [latestRaw, setLatestRaw] = useState<PingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failuresInRow, setFailuresInRow] = useState(0);
  const [isRunning, setIsRunning] = useState(true);

  const timerRef = useRef<number | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);
  const historyRef = useRef<PingSnapshot[]>([]);
  const latestRawRef = useRef<PingResponse | null>(null);
  const errorRef = useRef<string | null>(null);
  const failuresInRowRef = useRef(0);
  const onSampleRef = useLatestRef(onSample);
  const onErrorRef = useLatestRef(onError);

  const safeIntervalMs = Math.max(100, Math.floor(intervalMs));
  const safeRenderIntervalMs = Math.max(250, Math.floor(renderIntervalMs));
  const safeMaxPoints = Math.max(1, Math.floor(maxPoints));
  const safeRequestTimeoutMs = Math.max(500, Math.floor(requestTimeoutMs));

  const flushState = useCallback(() => {
    setHistory(historyRef.current);
    setLatestRaw(latestRawRef.current);
    setError(errorRef.current);
    setFailuresInRow(failuresInRowRef.current);
  }, []);

  const start = useCallback(() => {
    setIsRunning(true);
  }, []);

  const stop = useCallback(() => {
    setIsRunning(false);
  }, []);

  const clearHistory = useCallback(() => {
    historyRef.current = [];
    flushState();
  }, [flushState]);

  useEffect(() => {
    if (!isRunning) {
      clearTimer(timerRef);
      abortRef.current?.abort();
      return;
    }

    let disposed = false;

    const scheduleNextPoll = (delayMs: number) => {
      clearTimer(timerRef);
      timerRef.current = window.setTimeout(() => {
        void poll();
      }, delayMs);
    };

    const poll = async () => {
      if (disposed) {
        return;
      }

      if (
        !pollWhenHidden &&
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        scheduleNextPoll(safeIntervalMs);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;

      const timeoutId = window.setTimeout(() => {
        controller.abort();
      }, safeRequestTimeoutMs);

      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          ...fetchInit,
          method: "GET",
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Ping endpoint returned HTTP ${response.status}`);
        }

        const payload = normalisePingResponse(await response.json());
        const snapshot = createPingSnapshot(payload, sequenceRef.current++);

        latestRawRef.current = payload;
        errorRef.current = null;
        failuresInRowRef.current = 0;
        const nextHistory = [...historyRef.current, snapshot];
        historyRef.current =
          nextHistory.length > safeMaxPoints
            ? nextHistory.slice(nextHistory.length - safeMaxPoints)
            : nextHistory;

        onSampleRef.current?.(snapshot, payload);
      } catch (caughtError) {
        if (!disposed) {
          const nextError = controller.signal.aborted
            ? new Error(
                `Ping request timed out after ${safeRequestTimeoutMs} ms`,
              )
            : toError(caughtError);

          errorRef.current = nextError.message;
          failuresInRowRef.current += 1;
          onErrorRef.current?.(nextError);
        }
      } finally {
        window.clearTimeout(timeoutId);

        if (abortRef.current === controller) {
          abortRef.current = null;
        }

        if (!disposed) {
          scheduleNextPoll(safeIntervalMs);
        }
      }
    };

    void poll();

    return () => {
      disposed = true;
      clearTimer(timerRef);
      abortRef.current?.abort();
    };
  }, [
    endpoint,
    fetchInit,
    isRunning,
    pollWhenHidden,
    safeIntervalMs,
    safeMaxPoints,
    safeRequestTimeoutMs,
    onSampleRef,
    onErrorRef,
  ]);

  useEffect(() => {
    flushState();

    if (!isRunning) {
      clearTimer(flushTimerRef);
      return;
    }

    flushTimerRef.current = window.setInterval(() => {
      flushState();
    }, safeRenderIntervalMs);

    return () => {
      clearTimer(flushTimerRef);
    };
  }, [flushState, isRunning, safeRenderIntervalMs]);

  const latest = history.length > 0 ? history[history.length - 1] : null;

  return {
    history,
    latest,
    latestRaw,
    error,
    failuresInRow,
    isRunning,
    start,
    stop,
    clearHistory,
  };
}

export function RealtimePingDashboard({
  endpoint = DEFAULT_ENDPOINT,
  intervalMs = DEFAULT_INTERVAL_MS,
  renderIntervalMs = DEFAULT_RENDER_INTERVAL_MS,
  maxPoints = DEFAULT_MAX_POINTS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  pollWhenHidden = false,
  fetchInit,
  onSample,
  onError,
  title = "Live API status",
  subtitle = "Real-time system visibility from the rolling /ping endpoint.",
  className,
  theme = "dark",
  visibleModelLimit = 10,
  chartPointLimit = DEFAULT_CHART_POINT_LIMIT,
}: RealtimePingDashboardProps) {
  const {
    history,
    latest,
    error,
    failuresInRow,
    isRunning,
    start,
    stop,
    clearHistory,
  } = useRealtimePingMetrics({
    endpoint,
    intervalMs,
    renderIntervalMs,
    maxPoints,
    requestTimeoutMs,
    pollWhenHidden,
    fetchInit,
    onSample,
    onError,
  });

  const health = useMemo(
    () => getHealth(latest, error, failuresInRow),
    [latest, error, failuresInRow],
  );

  const topModels = useMemo(
    () => latest?.models.slice(0, visibleModelLimit) ?? [],
    [latest, visibleModelLimit],
  );
  const tableModels = useMemo(
    () =>
      [...(latest?.models ?? [])]
        .sort(
          (left, right) =>
            Number(right.attempts > 0) - Number(left.attempts > 0) ||
            right.availability - left.availability ||
            right.attempts - left.attempts ||
            left.model.localeCompare(right.model),
        )
        .slice(0, visibleModelLimit),
    [latest, visibleModelLimit],
  );
  const chartHistory = useMemo(
    () => compressSnapshots(history, chartPointLimit),
    [history, chartPointLimit],
  );

  return (
    <section
      className={[
        "llm7-dashboard",
        `llm7-dashboard--${theme}`,
        className ?? "",
      ].join(" ")}
    >
      <div className="llm7-hero">
        <div>
          <div className={`llm7-pill llm7-pill--${health.tone}`}>
            <span className="llm7-pill-dot" aria-hidden="true" />
            <span aria-live="polite">{health.label}</span>
          </div>

          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>

        <div className="llm7-actions">
          <button
            className="llm7-button llm7-button--primary"
            type="button"
            onClick={isRunning ? stop : start}
          >
            {isRunning ? "Pause" : "Resume"}
          </button>

          <button
            className="llm7-button"
            type="button"
            onClick={clearHistory}
            disabled={history.length === 0}
          >
            Clear
          </button>
        </div>
      </div>

      {error ? (
        <div className="llm7-alert" role="status">
          <strong>Latest poll failed.</strong>
          <span>{error}</span>
        </div>
      ) : null}

      <div className="llm7-kpis">
        <MetricCard
          label="Active requests"
          value={formatInteger(latest?.activeRequestsLast60s ?? 0)}
          hint="last 60 seconds"
        />

        <MetricCard
          label="HTTP 200"
          value={formatInteger(latest?.success200 ?? 0)}
          hint={`${formatPercent(latest?.successRate ?? 0)} success rate`}
        />

        <MetricCard
          label="Avg response time"
          value={formatSeconds(latest?.averageResponseTimeSeconds ?? 0)}
          hint={`${formatInteger(latest?.activeModelCount ?? 0)} active models`}
        />

        <MetricCard
          label="Avg availability"
          value={formatPercent(latest?.averageAvailability ?? 0, 1)}
          hint="models with attempts"
          tone={(latest?.averageAvailability ?? 1) < 0.7 ? "warning" : "normal"}
        />

        <MetricCard
          label="Tokens"
          value={formatInteger(latest?.totalTokens ?? 0)}
          hint="input + output, last 60 seconds"
        />

        <MetricCard
          label="Tokens / sec"
          value={formatDecimal(latest?.tokensPerSecond ?? 0, 0)}
          hint={`${formatInteger(history.length)} retained samples`}
        />
      </div>

      <ChartCard
        title="Availability over time"
        subtitle="Average availability across models with attempts in each rolling window."
        fullWidth
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartHistory}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="timeLabel" minTickGap={36} />
            <YAxis
              yAxisId="availability"
              domain={[0, 1]}
              tickFormatter={formatAxisPercent}
              width={52}
            />
            <YAxis
              yAxisId="latency"
              orientation="right"
              tickFormatter={formatAxisSeconds}
              width={56}
            />
            <Tooltip formatter={formatTooltipValue} />
            <Area
              yAxisId="availability"
              type="monotone"
              dataKey="averageAvailability"
              name={metricLabels.averageAvailability}
              stroke="var(--llm7-good)"
              fill="var(--llm7-good-soft)"
              strokeWidth={2.2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              yAxisId="latency"
              type="monotone"
              dataKey="averageResponseTimeSeconds"
              name={metricLabels.averageResponseTimeSeconds}
              stroke="var(--llm7-chart-b)"
              strokeWidth={2.2}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="llm7-chart-grid">
        <ChartCard
          title="Traffic pressure"
          subtitle="Active requests reported by the endpoint."
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartHistory}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="timeLabel" minTickGap={36} />
              <YAxis allowDecimals={false} width={48} />
              <Tooltip formatter={formatTooltipValue} />
              <Line
                type="monotone"
                dataKey="activeRequestsLast60s"
                name={metricLabels.activeRequestsLast60s}
                stroke="var(--llm7-chart-a)"
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Reliability"
          subtitle="Successes, errors, and timeouts in the rolling window."
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartHistory}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="timeLabel" minTickGap={36} />
              <YAxis allowDecimals={false} width={48} />
              <Tooltip formatter={formatTooltipValue} />
              <Legend />
              <Line
                type="monotone"
                dataKey="success200"
                name={metricLabels.success200}
                stroke="var(--llm7-good)"
                strokeWidth={2.2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="errorsTotal"
                name={metricLabels.errorsTotal}
                stroke="var(--llm7-bad)"
                strokeWidth={2.2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="timeouts"
                name={metricLabels.timeouts}
                stroke="var(--llm7-warn)"
                strokeWidth={2.2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Token movement"
          subtitle="Input and output tokens reported for all models."
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartHistory}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="timeLabel" minTickGap={36} />
              <YAxis allowDecimals={false} width={64} />
              <Tooltip formatter={formatTooltipValue} />
              <Legend />
              <Area
                type="monotone"
                dataKey="inputTokens"
                name={metricLabels.inputTokens}
                stroke="var(--llm7-chart-a)"
                fill="var(--llm7-chart-a-soft)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="outputTokens"
                name={metricLabels.outputTokens}
                stroke="var(--llm7-chart-b)"
                fill="var(--llm7-chart-b-soft)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Latest model load"
          subtitle={`Top ${visibleModelLimit} models by request volume.`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topModels}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="shortModel" interval={0} tickMargin={10} />
              <YAxis allowDecimals={false} width={48} />
              <Tooltip formatter={formatTooltipValue} />
              <Legend />
              <Bar
                dataKey="success200"
                name={metricLabels.success200}
                fill="var(--llm7-good)"
                radius={[8, 8, 0, 0]}
                isAnimationActive={false}
              />
              <Bar
                dataKey="errorsTotal"
                name={metricLabels.errorsTotal}
                fill="var(--llm7-bad)"
                radius={[8, 8, 0, 0]}
                isAnimationActive={false}
              />
              <Bar
                dataKey="timeouts"
                name={metricLabels.timeouts}
                fill="var(--llm7-warn)"
                radius={[8, 8, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="llm7-table-card">
        <div className="llm7-table-header">
          <div>
            <h3>Model health</h3>
            <p>Latest snapshot from the rolling 60-second metrics window.</p>
          </div>

          <span className="llm7-muted">
            {latest
              ? `Updated ${new Date(latest.collectedAt).toLocaleTimeString()}`
              : "Collecting data…"}
          </span>
        </div>

        <div className="llm7-table-wrap">
          <table className="llm7-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Requests</th>
                <th>HTTP 200</th>
                <th>Errors</th>
                <th>Timeouts</th>
                <th>Availability</th>
                <th>Avg time</th>
                <th>Tokens</th>
              </tr>
            </thead>

            <tbody>
              {tableModels.length > 0 ? (
                tableModels.map((model) => (
                  <tr key={model.model}>
                    <td>
                      <span className="llm7-model-name">{model.model}</span>
                    </td>
                    <td>{formatInteger(model.totalRequests)}</td>
                    <td>{formatInteger(model.success200)}</td>
                    <td>{formatInteger(model.errorsTotal)}</td>
                    <td>{formatInteger(model.timeouts)}</td>
                    <td>
                      {model.attempts > 0 ? (
                        <span
                          className={[
                            "llm7-rate",
                            model.availability >= 0.98
                              ? "llm7-rate--good"
                              : model.availability >= 0.7
                                ? "llm7-rate--warn"
                                : "llm7-rate--bad",
                          ].join(" ")}
                        >
                          {formatPercent(model.availability, 1)}
                        </span>
                      ) : (
                        <span className="llm7-rate llm7-rate--empty">-</span>
                      )}
                    </td>
                    <td>
                      {model.responseTimeSamples > 0
                        ? formatSeconds(model.averageResponseTimeSeconds)
                        : "-"}
                    </td>
                    <td>{formatInteger(model.totalTokens)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="llm7-empty">
                    Waiting for the first successful ping response.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="llm7-footer">
        <span>Endpoint: {endpoint}</span>
        <span>Polling: {formatInteger(intervalMs)} ms</span>
        <span>Render flush: {formatInteger(renderIntervalMs)} ms</span>
        <span>History cap: {formatInteger(maxPoints)} points</span>
      </div>
    </section>
  );
}

function MetricCard({
  label,
  value,
  hint,
  tone = "normal",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "normal" | "warning";
}) {
  return (
    <div className={`llm7-metric llm7-metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
  fullWidth = false,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  fullWidth?: boolean;
}) {
  return (
    <div
      className={[
        "llm7-chart-card",
        fullWidth ? "llm7-chart-card--full" : "",
      ].join(" ")}
    >
      <div className="llm7-chart-header">
        <h3>{title}</h3>
        <p>{subtitle}</p>
      </div>

      <div className="llm7-chart-body">{children}</div>
    </div>
  );
}

function createPingSnapshot(raw: PingResponse, id: number): PingSnapshot {
  const models = Object.entries(raw.model_metrics_last_60s)
    .map(([model, metrics]) => createModelSnapshot(model, metrics))
    .sort(
      (left, right) =>
        right.totalRequests - left.totalRequests ||
        right.totalTokens - left.totalTokens ||
        left.model.localeCompare(right.model),
    );

  const aggregate = models.reduce(
    (accumulator, model) => ({
      success200: accumulator.success200 + model.success200,
      errorsTotal: accumulator.errorsTotal + model.errorsTotal,
      errors4xx: accumulator.errors4xx + model.errors4xx,
      errors5xx: accumulator.errors5xx + model.errors5xx,
      timeouts: accumulator.timeouts + model.timeouts,
      inputTokens: accumulator.inputTokens + model.inputTokens,
      outputTokens: accumulator.outputTokens + model.outputTokens,
      totalTokens: accumulator.totalTokens + model.totalTokens,
      totalRequests: accumulator.totalRequests + model.totalRequests,
      activeModelCount:
        accumulator.activeModelCount + (model.attempts > 0 ? 1 : 0),
      availabilityTotal:
        accumulator.availabilityTotal +
        (model.attempts > 0 ? model.availability : 0),
      responseTimeTotal:
        accumulator.responseTimeTotal +
        (model.responseTimeSamples > 0 ? model.averageResponseTimeSeconds : 0),
      responseTimeModelCount:
        accumulator.responseTimeModelCount +
        (model.responseTimeSamples > 0 ? 1 : 0),
    }),
    {
      success200: 0,
      errorsTotal: 0,
      errors4xx: 0,
      errors5xx: 0,
      timeouts: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalRequests: 0,
      activeModelCount: 0,
      availabilityTotal: 0,
      responseTimeTotal: 0,
      responseTimeModelCount: 0,
    },
  );

  const collectedAt = Date.now();

  return {
    id,
    collectedAt,
    timeLabel: formatTimeLabel(collectedAt),
    activeRequestsLast60s: raw.active_requests_last_60s,
    success200: aggregate.success200,
    errorsTotal: aggregate.errorsTotal,
    errors4xx: aggregate.errors4xx,
    errors5xx: aggregate.errors5xx,
    timeouts: aggregate.timeouts,
    inputTokens: aggregate.inputTokens,
    outputTokens: aggregate.outputTokens,
    totalTokens: aggregate.totalTokens,
    totalRequests: aggregate.totalRequests,
    successRate: ratio(aggregate.success200, aggregate.totalRequests),
    errorRate: ratio(aggregate.errorsTotal, aggregate.totalRequests),
    timeoutRate: ratio(aggregate.timeouts, aggregate.totalRequests),
    averageResponseTimeSeconds:
      aggregate.responseTimeModelCount > 0
        ? aggregate.responseTimeTotal / aggregate.responseTimeModelCount
        : 0,
    averageAvailability:
      aggregate.activeModelCount > 0
        ? aggregate.availabilityTotal / aggregate.activeModelCount
        : 0,
    activeModelCount: aggregate.activeModelCount,
    tokensPerSecond: aggregate.totalTokens / 60,
    modelCount: models.length,
    models,
  };
}

function createModelSnapshot(
  model: string,
  metrics: ModelMetrics,
): ModelSnapshot {
  const success200 = metrics.success_200;
  const errorsTotal = metrics.errors.total;
  const attempts = metrics.health.attempts;
  const totalRequests = success200 + errorsTotal;
  const inputTokens = metrics.tokens.input;
  const outputTokens = metrics.tokens.output;

  return {
    model,
    shortModel: shortenModelName(model),
    success200,
    errorsTotal,
    errors4xx: metrics.errors["4xx"],
    errors5xx: metrics.errors["5xx"],
    timeouts: metrics.errors.timeouts,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    totalRequests,
    successRate: ratio(success200, totalRequests),
    errorRate: ratio(errorsTotal, totalRequests),
    timeoutRate: ratio(metrics.errors.timeouts, totalRequests),
    averageResponseTimeSeconds: metrics.response_time.average_seconds,
    responseTimeSamples: metrics.response_time.samples,
    attempts,
    availability: 1 - clampRatio(metrics.health.error_rate),
    routingHealthy: metrics.health.routing_healthy,
  };
}

export function normalisePingResponse(payload: unknown): PingResponse {
  if (!isRecord(payload)) {
    throw new Error("Ping response is not a JSON object");
  }

  const rawModelMetrics = isRecord(payload.model_metrics_last_60s)
    ? payload.model_metrics_last_60s
    : {};

  const modelMetrics: Record<string, ModelMetrics> = {};

  for (const [modelName, value] of Object.entries(rawModelMetrics)) {
    if (modelName.trim().length > 0) {
      modelMetrics[modelName] = normaliseModelMetrics(value);
    }
  }

  return {
    message: typeof payload.message === "string" ? payload.message : "",
    active_requests_last_60s: readFiniteNumber(
      payload.active_requests_last_60s,
    ),
    model_metrics_last_60s: modelMetrics,
  };
}

function normaliseModelMetrics(value: unknown): ModelMetrics {
  const record = isRecord(value) ? value : {};
  const errors = isRecord(record.errors) ? record.errors : {};
  const tokens = isRecord(record.tokens) ? record.tokens : {};
  const responseTime = isRecord(record.response_time) ? record.response_time : {};
  const health = isRecord(record.health) ? record.health : {};

  return {
    success_200: readFiniteNumber(record.success_200),
    errors: {
      total: readFiniteNumber(errors.total),
      "4xx": readFiniteNumber(errors["4xx"]),
      "5xx": readFiniteNumber(errors["5xx"]),
      timeouts: readFiniteNumber(errors.timeouts),
    },
    tokens: {
      input: readFiniteNumber(tokens.input),
      output: readFiniteNumber(tokens.output),
    },
    response_time: {
      average_seconds: readFiniteNumber(responseTime.average_seconds),
      samples: readFiniteNumber(responseTime.samples),
    },
    health: {
      attempts: readFiniteNumber(health.attempts),
      error_rate: clampRatio(readFiniteNumber(health.error_rate)),
      routing_healthy:
        typeof health.routing_healthy === "boolean"
          ? health.routing_healthy
          : true,
    },
  };
}

function getHealth(
  latest: PingSnapshot | null,
  error: string | null,
  failuresInRow: number,
): {
  label: string;
  tone: "good" | "warn" | "bad" | "idle";
} {
  if (failuresInRow >= 3) {
    return {
      label: "Ping endpoint unreachable",
      tone: "bad",
    };
  }

  if (error) {
    return {
      label: "Latest ping failed",
      tone: "warn",
    };
  }

  if (!latest) {
    return {
      label: "Collecting live data",
      tone: "idle",
    };
  }

  if (latest.totalRequests === 0 && latest.activeRequestsLast60s === 0) {
    return {
      label: "Quiet",
      tone: "idle",
    };
  }

  if (latest.success200 === 0 && latest.errorsTotal > 0) {
    return {
      label: "No successful model responses",
      tone: "bad",
    };
  }

  if (
    latest.averageAvailability < 0.4 ||
    latest.errorRate >= 0.35 ||
    latest.timeoutRate >= 0.25
  ) {
    return {
      label: "Severe degradation",
      tone: "bad",
    };
  }

  if (latest.averageAvailability < 0.7) {
    return {
      label: "Partially degraded",
      tone: "warn",
    };
  }

  return {
    label: "Operational",
    tone: "good",
  };
}

function useLatestRef<T>(value: T) {
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return ref;
}

function clearTimer(timerRef: MutableRefObject<number | null>) {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(typeof value === "string" ? value : "Unknown ping error");
}

function shortenModelName(model: string): string {
  return model.length > 18 ? `${model.slice(0, 16)}…` : model;
}

function compressSnapshots(
  history: PingSnapshot[],
  pointLimit: number,
): PingSnapshot[] {
  const safePointLimit = Math.max(12, Math.floor(pointLimit));

  if (history.length <= safePointLimit) {
    return history;
  }

  const step = Math.ceil(history.length / safePointLimit);
  const compressed: PingSnapshot[] = [];

  for (let index = 0; index < history.length; index += step) {
    compressed.push(history[index]);
  }

  const latest = history[history.length - 1];

  if (compressed[compressed.length - 1]?.id !== latest.id) {
    compressed[compressed.length - 1] = latest;
  }

  return compressed;
}

function formatTimeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const hhmmss = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return `${hhmmss}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDecimal(value: number, digits: number): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatSeconds(value: number): string {
  return `${formatDecimal(value, 3)}s`;
}

function formatPercent(value: number, decimals?: number): string {
  const digits =
    typeof decimals === "number"
      ? decimals
      : value >= 0.995 || value === 0
        ? 0
        : 1;

  return `${(value * 100).toFixed(digits)}%`;
}

function formatAxisPercent(value: number): string {
  return formatPercent(value, 0);
}

function formatAxisSeconds(value: number): string {
  return `${value.toFixed(1)}s`;
}

function formatTooltipValue(
  value: unknown,
  name: unknown,
  item?: { dataKey?: unknown },
): [ReactNode, string] {
  const metricKey =
    typeof item?.dataKey === "string"
      ? item.dataKey
      : typeof name === "string"
        ? name
        : "";
  const label =
    typeof name === "string" ? metricLabels[metricKey] ?? name : String(name);
  const formattedValue =
    typeof value === "number"
      ? metricKey === "averageAvailability"
        ? formatPercent(value, 1)
        : metricKey === "averageResponseTimeSeconds"
          ? formatSeconds(value)
        : formatInteger(value)
      : String(value);

  return [formattedValue, label];
}
