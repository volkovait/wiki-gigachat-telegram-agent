import { useCallback, useState } from "react";

type ApiResponse = {
  simplifiedResponse: string;
  wikiTitle: string;
  wikiUrl: string;
  wikiFetchError: string | null;
  telegramSent: boolean;
  error: string | null;
  /** Имена нод LangGraph в порядке исполнения */
  nodeTrace: string[];
};

export function App() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setLoading(true);
    setRequestError(null);
    setResult(null);
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = (await res.json()) as ApiResponse & { error?: string; nodeTrace?: string[] };
      if (!res.ok) {
        setRequestError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult({
        ...data,
        nodeTrace: Array.isArray(data.nodeTrace) ? data.nodeTrace : [],
      });
    } catch (e) {
      setRequestError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [query]);

  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "2rem 1.25rem",
      }}
    >
      <header style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.35rem" }}>
          Агент: Википедия → GigaChat → Telegram
        </h1>
        <p style={{ margin: 0, color: "#475569", fontSize: "0.95rem" }}>
          Запрос уходит в граф LangGraph: поиск в русской Википедии, упрощённое объяснение через
          GigaChat, затем сообщение в Telegram.
        </p>
      </header>

      <label
        htmlFor="q"
        style={{ display: "block", fontWeight: 600, marginBottom: "0.35rem", fontSize: "0.9rem" }}
      >
        Ваш вопрос
      </label>
      <textarea
        id="q"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        rows={4}
        placeholder="Например: Что такое LangGraph?"
        style={{
          width: "100%",
          padding: "0.75rem",
          borderRadius: 8,
          border: "1px solid #cbd5e1",
          fontSize: "1rem",
          resize: "vertical",
        }}
      />

      <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={loading}
          style={{
            padding: "0.6rem 1.1rem",
            borderRadius: 8,
            border: "none",
            background: "#0f766e",
            color: "#fff",
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "Обработка…" : "Отправить"}
        </button>
      </div>

      {requestError ? (
        <p style={{ color: "#b91c1c", marginTop: "1rem" }} role="alert">
          {requestError}
        </p>
      ) : null}

      {result ? (
        <article
          style={{
            marginTop: "1.5rem",
            padding: "1rem 1.1rem",
            background: "#fff",
            borderRadius: 10,
            border: "1px solid #e2e8f0",
          }}
        >
          {result.wikiTitle ? (
            <p style={{ margin: "0 0 0.5rem", fontSize: "0.9rem", color: "#475569" }}>
              Статья:{" "}
              {result.wikiUrl ? (
                <a href={result.wikiUrl} target="_blank" rel="noreferrer">
                  {result.wikiTitle}
                </a>
              ) : (
                result.wikiTitle
              )}
            </p>
          ) : null}
          {result.wikiFetchError ? (
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.9rem", color: "#b45309" }}>
              Википедия: {result.wikiFetchError}
            </p>
          ) : null}
          {result.nodeTrace.length > 0 ? (
            <section style={{ marginBottom: "1rem" }} aria-label="Порядок нод графа">
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.4rem" }}>Журнал нод (LangGraph)</h2>
              <ol
                style={{
                  margin: 0,
                  paddingLeft: "1.25rem",
                  fontSize: "0.9rem",
                  color: "#334155",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {result.nodeTrace.map((name, i) => (
                  <li key={`${name}-${i}`}>
                    {i + 1}. {name}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Ответ (простым языком)</h2>
          <div style={{ whiteSpace: "pre-wrap" }}>{result.simplifiedResponse}</div>
          <p style={{ margin: "1rem 0 0", fontSize: "0.85rem", color: "#64748b" }}>
            Telegram: {result.telegramSent ? "отправлено" : "не отправлено"}
            {result.error ? ` — ${result.error}` : ""}
          </p>
        </article>
      ) : null}
    </div>
  );
}
