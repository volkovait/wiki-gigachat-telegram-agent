import { StateGraph, START, END } from "@langchain/langgraph";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import { fetchWikipediaExtract } from "./wiki.js";
import { isOutOfScopeForWikipedia } from "./wikiQueryGate.js";
import { gigachatComplete } from "./gigachat.js";
import { sendTelegramMessage } from "./telegram.js";

/**
 * Состояние графа (как в `ref/index.js`): Zod-схема + служебные поля шагов и ошибок.
 *
 * Граф — это направленный workflow из нод (функций). Каждая нода читает state и возвращает
 * частичное обновление; LangGraph накладывает патчи последовательно по рёбрам.
 */
export const WikiAgentState = z.object({
  userQuery: z.string().default(""),
  wikiTitle: z.string().default(""),
  wikiExtract: z.string().default(""),
  wikiUrl: z.string().default(""),
  wikiFetchError: z.string().nullable().default(null),
  simplifiedResponse: z.string().default(""),
  error: z.string().nullable().default(null),
  telegramSent: z.boolean().default(false),
  messages: z.array(z.any()).default([]),
  metadata: z.record(z.any()).default({}),
  /** Внутренний маршрут после ingest: "wikipedia" | "empty" | "out_of_scope" */
  routeAfterIngest: z.string().default(""),
  /**
   * Журнал вызовов нод в порядке исполнения (имена из `.addNode(...)`).
   * Заполняется вручную в каждой ноде, чтобы UI/API видели реальный путь (в т.ч. при ветвлении).
   */
  nodeTrace: z.array(z.string()).default([]),
});

type WikiAgentStateType = z.infer<typeof WikiAgentState>;

/** Нормализация запроса и выбор ветки: пустой вопрос → сразу END, иначе → Википедия. */
async function ingestQuery(state: WikiAgentStateType): Promise<Partial<WikiAgentStateType>> {
  const q = state.userQuery.trim();
  const trace = [...state.nodeTrace, "ingest"];
  if (!q) {
    return {
      routeAfterIngest: "empty",
      simplifiedResponse: "Введите непустой вопрос.",
      error: null,
      metadata: { ...state.metadata, ingestAt: new Date().toISOString() },
      nodeTrace: trace,
    };
  }
  if (isOutOfScopeForWikipedia(q)) {
    return {
      userQuery: q,
      routeAfterIngest: "out_of_scope",
      simplifiedResponse:
        "Этот сервис отвечает только на энциклопедические вопросы: факты, понятия, биографии, события — по материалам русской Википедии. Практические темы вроде заработка, личных советов или бытовых рекомендаций здесь не обрабатываются.",
      error: null,
      metadata: { ...state.metadata, ingestAt: new Date().toISOString(), ingestSkippedWiki: true },
      nodeTrace: trace,
    };
  }
  return {
    userQuery: q,
    routeAfterIngest: "wikipedia",
    wikiFetchError: null,
    metadata: { ...state.metadata, ingestAt: new Date().toISOString() },
    nodeTrace: trace,
  };
}

/** Поиск статьи в русской Википедии по тексту запроса. */
async function fetchWikipediaNode(
  state: WikiAgentStateType,
): Promise<Partial<WikiAgentStateType>> {
  const result = await fetchWikipediaExtract(state.userQuery);
  const trace = [...state.nodeTrace, "fetch_wikipedia"];

  if (result.ok) {
    return {
      wikiTitle: result.title,
      wikiExtract: result.extract,
      wikiUrl: result.url,
      wikiFetchError: null,
      metadata: {
        ...state.metadata,
        wikipediaAt: new Date().toISOString(),
      },
      nodeTrace: trace,
    };
  }

  return {
    wikiTitle: "",
    wikiExtract: "",
    wikiUrl: "",
    wikiFetchError: result.error,
    metadata: {
      ...state.metadata,
      wikipediaAt: new Date().toISOString(),
    },
    nodeTrace: trace,
  };
}

/** Сжатое объяснение через GigaChat (с текстом статьи или с сообщением об ошибке Википедии). */
async function summarizeWithGigaChat(
  state: WikiAgentStateType,
): Promise<Partial<WikiAgentStateType>> {
  const trace = [...state.nodeTrace, "summarize"];
  const hasWiki = !state.wikiFetchError && state.wikiExtract.length > 0;

  const system = hasWiki
    ? `Ты помощник. Объясни пользователю простым языком на русском, опираясь на фрагмент из Википедии. 
Не выдумывай факты сверх текста статьи. Можно кратко упомянуть ссылку на статью в конце.`
    : `Ты помощник. Пользователь задал вопрос, но из Википедии не удалось получить текст (ошибка или пустой поиск). 
Кратко и простым языком объясни ситуацию и что можно сделать (переформулировать запрос). Не придумывай содержание статьи.`;

  const userBlock = hasWiki
    ? `Вопрос пользователя: ${state.userQuery}

Заголовок статьи: ${state.wikiTitle}
Ссылка: ${state.wikiUrl}

Текст из Википедии:
${state.wikiExtract}`
    : `Вопрос пользователя: ${state.userQuery}

Проблема с Википедией: ${state.wikiFetchError ?? "неизвестно"}`;

  try {
    const text = await gigachatComplete([
      { role: "system", content: system },
      { role: "user", content: userBlock },
    ]);

    const userMessage = new HumanMessage(state.userQuery);
    const aiMessage = new AIMessage(text);

    return {
      simplifiedResponse: text,
      messages: [...state.messages, userMessage, aiMessage],
      error: null,
      metadata: {
        ...state.metadata,
        gigachatAt: new Date().toISOString(),
      },
      nodeTrace: trace,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      error: message,
      simplifiedResponse:
        "Не удалось получить ответ от GigaChat. Проверьте GIGACHAT_AUTHORIZATION_KEY и доступ к API.",
      metadata: {
        ...state.metadata,
        gigachatErrorAt: new Date().toISOString(),
      },
      nodeTrace: trace,
    };
  }
}

/** Отправка итогового текста в Telegram (если есть что слать). */
async function sendTelegramNode(
  state: WikiAgentStateType,
): Promise<Partial<WikiAgentStateType>> {
  const trace = [...state.nodeTrace, "telegram"];
  if (!state.simplifiedResponse.trim()) {
    return { telegramSent: false, nodeTrace: trace };
  }

  try {
    const payload = [
      state.wikiUrl ? `🔗 ${state.wikiUrl}` : null,
      "",
      state.simplifiedResponse,
    ]
      .filter((line) => line !== null)
      .join("\n");

    await sendTelegramMessage(payload.slice(0, 4096));
    return {
      telegramSent: true,
      metadata: {
        ...state.metadata,
        telegramAt: new Date().toISOString(),
      },
      nodeTrace: trace,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      telegramSent: false,
      error: message,
      metadata: {
        ...state.metadata,
        telegramErrorAt: new Date().toISOString(),
      },
      nodeTrace: trace,
    };
  }
}

/** Условное ребро из `ingest`: куда идти дальше (ключи должны совпадать с мапой в addConditionalEdges). */
function routeAfterIngest(state: WikiAgentStateType): string {
  if (state.routeAfterIngest === "empty") return "empty";
  if (state.routeAfterIngest === "out_of_scope") return "out_of_scope";
  return "wikipedia";
}

/**
 * Сборка графа:
 *   START → ingest → (пустой / вне Википедии?) → END
 *                    → иначе → fetch_wikipedia → summarize → telegram → END
 *
 * `StateGraph(WikiAgentState)` — состояние валидируется/мержится по Zod-схеме.
 * `addConditionalEdges` — ветвление по строке, которую возвращает `routeAfterIngest`.
 */
const workflow = new StateGraph(WikiAgentState)
  .addNode("ingest", ingestQuery)
  .addNode("fetch_wikipedia", fetchWikipediaNode)
  .addNode("summarize", summarizeWithGigaChat)
  .addNode("telegram", sendTelegramNode)

  .addEdge(START, "ingest")
  .addConditionalEdges("ingest", routeAfterIngest, {
    wikipedia: "fetch_wikipedia",
    empty: END,
    out_of_scope: END,
  })
  .addEdge("fetch_wikipedia", "summarize")
  .addEdge("summarize", "telegram")
  .addEdge("telegram", END);

const wikiAgentApp = workflow.compile();

export async function runWikiAgent(userQuery: string): Promise<WikiAgentStateType> {
  const initial: WikiAgentStateType = {
    userQuery,
    wikiTitle: "",
    wikiExtract: "",
    wikiUrl: "",
    wikiFetchError: null,
    simplifiedResponse: "",
    error: null,
    telegramSent: false,
    messages: [],
    metadata: { startedAt: new Date().toISOString() },
    routeAfterIngest: "",
    nodeTrace: [],
  };

  const result = await wikiAgentApp.invoke(initial);
  return result;
}
