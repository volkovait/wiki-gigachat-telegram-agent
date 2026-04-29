import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { runWikiAgent } from "./graph.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/query", async (req, res) => {
  const body = req.body as { query?: unknown };
  const query = typeof body.query === "string" ? body.query : "";

  try {
    const result = await runWikiAgent(query);
    res.json({
      simplifiedResponse: result.simplifiedResponse,
      wikiTitle: result.wikiTitle,
      wikiUrl: result.wikiUrl,
      wikiFetchError: result.wikiFetchError,
      telegramSent: result.telegramSent,
      error: result.error,
      nodeTrace: result.nodeTrace,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => {
  console.log(`Wiki agent API: http://localhost:${port}`);
});
