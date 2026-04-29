import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import * as https from "node:https";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath, URL } from "node:url";

const OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const CHAT_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Корень монорепо (рядом с `server/`, где лежит `.env` и часто `*.pem`). */
function repoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function resolveCertPath(raw: string): string {
  const t = raw.trim();
  if (path.isAbsolute(t)) return t;
  const fromCwd = path.resolve(process.cwd(), t);
  if (existsSync(fromCwd)) return fromCwd;
  return path.resolve(repoRoot(), t);
}

/**
 * PEM для проверки цепочки TLS GigaChat (НУЦ / Russian Trusted Root).
 * Приоритет: `GIGACHAT_CA_BUNDLE` → `NODE_EXTRA_CA_CERTS` (читаем файл сами: из `.env` встроенный Node не подхватывает) → `russian_trusted_root_ca.pem` в корне репо.
 * Без файла используются только системные CA (на macOS запросы к Sber часто падают).
 */
function loadCaBundle(): string[] | undefined {
  const fromEnv =
    process.env.GIGACHAT_CA_BUNDLE?.trim() ?? process.env.NODE_EXTRA_CA_CERTS?.trim();
  if (fromEnv) {
    const p = resolveCertPath(fromEnv);
    if (!existsSync(p)) {
      throw new Error(`CA bundle: файл не найден: ${p} (GIGACHAT_CA_BUNDLE / NODE_EXTRA_CA_CERTS)`);
    }
    const pem = readFileSync(p, "utf8");
    return [...tls.rootCertificates, pem];
  }
  const defaultPem = path.join(repoRoot(), "russian_trusted_root_ca.pem");
  if (existsSync(defaultPem)) {
    const pem = readFileSync(defaultPem, "utf8");
    return [...tls.rootCertificates, pem];
  }
  return undefined;
}

let cachedCa: string[] | undefined | null = null;

function getRequestTlsOptions(): https.RequestOptions {
  if (cachedCa === null) {
    cachedCa = loadCaBundle() ?? undefined;
  }
  if (!cachedCa) return {};
  return { ca: cachedCa };
}

type HttpsResult = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

/** TLS к Sбер-хостам с дополнительным CA (native fetch в Node так не умеет без undici). */
function gigachatHttpsRequest(
  urlString: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<HttpsResult> {
  const url = new URL(urlString);
  const tlsOpts = getRequestTlsOptions();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: init.method,
        headers: init.headers,
        ...tlsOpts,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          const ok = status >= 200 && status < 300;
          resolve({
            ok,
            status,
            text: async () => body.toString("utf8"),
            json: async () => JSON.parse(body.toString("utf8")) as unknown,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) {
      req.write(init.body);
    }
    req.end();
  });
}

type TokenCache = {
  accessToken: string;
  expiresAtMs: number;
};

let cache: TokenCache | null = null;

function getAuthKey(): string {
  const key = process.env.GIGACHAT_AUTHORIZATION_KEY?.trim();
  if (!key) {
    throw new Error("Не задан GIGACHAT_AUTHORIZATION_KEY (ключ из кабинета GigaChat)");
  }
  return key;
}

async function obtainAccessToken(): Promise<TokenCache> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "GIGACHAT_API_PERS",
  });

  const res = await gigachatHttpsRequest(OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      RqUID: randomUUID(),
      Authorization: `Basic ${getAuthKey()}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GigaChat OAuth: ${res.status} ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    access_token?: string;
    expires_at?: number;
  };

  const accessToken = json.access_token;
  if (!accessToken) {
    throw new Error("GigaChat OAuth: в ответе нет access_token");
  }

  const expiresAtMs =
    typeof json.expires_at === "number" ? json.expires_at * 1000 : Date.now() + 25 * 60 * 1000;

  return { accessToken, expiresAtMs };
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAtMs - 60_000 > now) {
    return cache.accessToken;
  }
  cache = await obtainAccessToken();
  return cache.accessToken;
}

type GigaChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function gigachatComplete(messages: GigaChatMessage[]): Promise<string> {
  const token = await getAccessToken();

  const res = await gigachatHttpsRequest(CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: "GigaChat",
      messages,
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GigaChat chat: ${res.status} ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = json.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("GigaChat: пустой ответ модели");
  }

  return content.trim();
}
