"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type LogEntry = {
  lineNumber: number;
  requested_datetime: string;
  ip: string;
  generated_filename: string;
  threadIndex: number;
};

/** Format ISO UTC string for display in Eastern (EST/EDT). */
function formatEst(isoUtc: string): string {
  try {
    const d = new Date(isoUtc);
    return d.toLocaleString("en-US", { timeZone: "America/New_York" });
  } catch {
    return isoUtc;
  }
}

function LogsContent() {
  const searchParams = useSearchParams();
  const key = searchParams.get("key") ?? "";

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [filterIp, setFilterIp] = useState("");
  const [filterFilename, setFilterFilename] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchLogs = useCallback(() => {
    if (!key.trim()) {
      setLogs([]);
      setTotal(0);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ key, page: String(page), limit: String(limit) });
    if (filterIp.trim()) params.set("ip", filterIp.trim());
    if (filterFilename.trim()) params.set("filename", filterFilename.trim());
    fetch(`/api/logs?${params}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Failed to load logs");
          setLogs([]);
          setTotal(0);
          return;
        }
        setLogs(data.logs ?? []);
        setTotal(data.total ?? 0);
      })
      .catch((err) => {
        setError(err?.message ?? "Request failed");
        setLogs([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [key, page, limit, filterIp, filterFilename]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  if (!key) {
    return (
      <main style={{ padding: "2rem", maxWidth: "32rem", margin: "0 auto" }}>
        <h1>Logs</h1>
        <p>Add your secret key to the URL: <code>?key=your_log_viewer_secret</code></p>
        <p style={{ marginTop: "1rem", color: "#555" }}>
          <strong>Local:</strong> Set <code>LOG_VIEWER_SECRET</code> in <code>.env.local</code>, then open{" "}
          <a href="http://localhost:3000/logs?key=your_secret">http://localhost:3000/logs?key=your_secret</a> (use your actual secret).
        </p>
      </main>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <main style={{ padding: "2rem", maxWidth: "56rem", margin: "0 auto" }}>
      <h1>Generation logs</h1>

      <div style={{ marginBottom: "1rem", display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center" }}>
        <label>
          IP filter:{" "}
          <input
            type="text"
            value={filterIp}
            onChange={(e) => setFilterIp(e.target.value)}
            placeholder="e.g. 192.168"
            style={{ padding: "0.25rem 0.5rem" }}
          />
        </label>
        <label>
          Filename filter:{" "}
          <input
            type="text"
            value={filterFilename}
            onChange={(e) => setFilterFilename(e.target.value)}
            placeholder="e.g. .docx"
            style={{ padding: "0.25rem 0.5rem" }}
          />
        </label>
        <button type="button" onClick={() => setPage(1)} style={{ padding: "0.25rem 0.75rem" }}>
          Apply filters
        </button>
      </div>

      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {loading && <p>Loading…</p>}
      {!loading && !error && total === 0 && (
        <p style={{ color: "#666", marginTop: "0.5rem" }}>
          No log entries yet. Generate a DOCX from the <a href="/">main page</a> to create entries.
        </p>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.5rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #333", textAlign: "left" }}>
              <th style={{ padding: "0.5rem" }}>#</th>
              <th style={{ padding: "0.5rem" }}>Requested (EST)</th>
              <th style={{ padding: "0.5rem" }}>IP</th>
              <th style={{ padding: "0.5rem" }}>Generated filename</th>
              <th style={{ padding: "0.5rem" }}>Thread</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((row) => (
              <tr key={row.lineNumber} style={{ borderBottom: "1px solid #ccc" }}>
                <td style={{ padding: "0.5rem" }}>{row.lineNumber}</td>
                <td style={{ padding: "0.5rem" }}>{formatEst(row.requested_datetime)}</td>
                <td style={{ padding: "0.5rem" }}>{row.ip}</td>
                <td style={{ padding: "0.5rem" }}>{row.generated_filename}</td>
                <td style={{ padding: "0.5rem" }}>{row.threadIndex}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: "1rem", display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
        <span>Page {page} of {totalPages} (total {total} entries)</span>
        <label>
          Per page:{" "}
          <select
            value={limit}
            onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
            style={{ padding: "0.25rem" }}
          >
            {[10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
          style={{ padding: "0.25rem 0.75rem" }}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
          style={{ padding: "0.25rem 0.75rem" }}
        >
          Next
        </button>
      </div>
    </main>
  );
}

export default function LogsPage() {
  return (
    <Suspense fallback={<main style={{ padding: "2rem", maxWidth: "32rem", margin: "0 auto" }}><p>Loading…</p></main>}>
      <LogsContent />
    </Suspense>
  );
}
