/**
 * Учебный пример: условный граф LangGraph
 * Демонстрирует условные переходы, классификацию запросов, обработку ошибок и fallback.
 * Запуск: node index.js [ "ваш запрос" ] — без аргумента выполняются тестовые запросы.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { z } from "zod";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Определяем __dirname для ES-модулей и подгружаем .env из родительской папки
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// --- Схема состояния графа (Zod) ---
// Все узлы читают и возвращают обновления этого состояния
const ConditionalGraphState = z.object({
  userQuery: z.string().default(""),
  response: z.string().default(""),
  messages: z.array(z.any()).default([]),
  queryType: z.string().default(""),
  confidence: z.number().default(0),
  error: z.string().nullable().default(null),
  retryCount: z.number().default(0),
  fallbackUsed: z.boolean().default(false),
  nextStep: z.string().default(""),
  metadata: z.record(z.any()).default({})
});

// --- Узел: валидация и классификация запроса ---
// Определяет queryType (simple | complex | error | normal) и confidence без вызова API
async function validateQuery(state) {
  console.log("🔍 Валидирую запрос:", state.userQuery);

  const query = state.userQuery.toLowerCase();

  // Короткие общие вопросы — простой тип
  if (query.length < 50 && (
    query.includes("что такое") ||
    query.includes("кто такой") ||
    query.includes("как называется")
  )) {
    console.log("✅ Простой запрос");
    return {
      ...state,
      queryType: "simple",
      confidence: 0.9
    };
  }

  // Длинные или аналитические запросы — сложный тип
  if (query.length > 100 || (
    query.includes("анализ") ||
    query.includes("сравни") ||
    query.includes("объясни подробно")
  )) {
    console.log("🔍 Сложный запрос");
    return {
      ...state,
      queryType: "complex",
      confidence: 0.7
    };
  }

  // Упоминание ошибок/проблем — тип error (можно направить в fallback)
  if (query.includes("ошибка") || query.includes("проблема") || query.includes("не работает")) {
    console.log("⚠️ Запрос с проблемой");
    return {
      ...state,
      queryType: "error",
      confidence: 0.5
    };
  }

  // Остальное — обычный запрос
  console.log("📝 Обычный запрос");
  return {
    ...state,
    queryType: "normal",
    confidence: 0.8
  };
}

// --- Узел: обработка простых запросов (LLM) ---
// Низкая температура, мало токенов — быстрый краткий ответ
async function processSimpleQuery(state) {
  console.log("⚡ Обрабатываю простой запрос");

  // Модель ChatOpenAI (bothub.chat / OpenAI-совместимый endpoint)
  const model = new ChatOpenAI({
    modelName: "gpt-4o-mini",
    temperature: 0.3,
    openAIApiKey: process.env.OPENAI_API_KEY,
    configuration: {
      baseURL: "https://bothub.chat/api/v2/openai/v1",
    },
  });

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "Дай краткий и точный ответ на русском языке. Максимум 2-3 предложения."],
    ["human", "{query}"]
  ]);

  try {
    const chain = prompt.pipe(model);
    const result = await chain.invoke({ query: state.userQuery });

    const userMessage = new HumanMessage(state.userQuery);
    const aiMessage = new AIMessage(result.content);

    return {
      ...state,
      response: result.content,
      messages: [...state.messages, userMessage, aiMessage],
      confidence: 0.9,
      metadata: {
        ...state.metadata,
        processedAt: new Date().toISOString(),
        node: "simple_processor"
      }
    };

  } catch (error) {
    console.error("❌ Ошибка в простом процессоре:", error.message);
    return {
      ...state,
      error: error.message,
      confidence: 0.1
    };
  }
}

// --- Узел: обработка сложных запросов (LLM) ---
// Высокая температура, больше токенов — развёрнутый анализ
async function processComplexQuery(state) {
  console.log("🧠 Обрабатываю сложный запрос");

  // Модель ChatOpenAI (bothub.chat / OpenAI-совместимый endpoint)
  const model = new ChatOpenAI({
    modelName: "gpt-4o-mini",
    temperature: 0.7,
    openAIApiKey: process.env.OPENAI_API_KEY,
    configuration: {
      baseURL: "https://bothub.chat/api/v2/openai/v1",
    },
  });

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "Проведи детальный анализ и дай развернутый ответ на русском языке. Используй актуальную информацию."],
    ["human", "{query}"]
  ]);

  try {
    const chain = prompt.pipe(model);
    const result = await chain.invoke({ query: state.userQuery });

    const userMessage = new HumanMessage(state.userQuery);
    const aiMessage = new AIMessage(result.content);

    return {
      ...state,
      response: result.content,
      messages: [...state.messages, userMessage, aiMessage],
      confidence: 0.8,
      metadata: {
        ...state.metadata,
        processedAt: new Date().toISOString(),
        node: "complex_processor"
      }
    };

  } catch (error) {
    console.error("❌ Ошибка в сложном процессоре:", error.message);
    return {
      ...state,
      error: error.message,
      confidence: 0.2
    };
  }
}

// --- Узел: fallback при ошибках ---
// Возвращает дружелюбное сообщение без вызова API
async function fallbackProcessor(state) {
  console.log("🛟 Использую fallback обработку");

  const fallbackResponse = `Извините, у меня возникли проблемы с обработкой вашего запроса: "${state.userQuery}". 
  
Попробуйте переформулировать вопрос или обратиться к технической поддержке.`;

  const userMessage = new HumanMessage(state.userQuery);
  const aiMessage = new AIMessage(fallbackResponse);

  return {
    ...state,
    response: fallbackResponse,
    messages: [...state.messages, userMessage, aiMessage],
    fallbackUsed: true,
    confidence: 0.3,
    metadata: {
      ...state.metadata,
      processedAt: new Date().toISOString(),
      node: "fallback_processor",
      fallbackReason: state.error || "unknown"
    }
  };
}

// --- Узел принятия решений (маршрутизатор) ---
// Возвращает nextStep: "simple" | "complex" | "fallback" | "end" для условных рёбер
function decideNextStep(state) {
  console.log("🤔 Принимаю решение о следующем шаге");

  if (state.error) {
    console.log("⚠️ Обнаружена ошибка, переходим к fallback");
    return {
      ...state,
      nextStep: "fallback"
    };
  }

  // Ответ уже есть — завершаем граф
  if (state.response && state.response.length > 10) {
    console.log("✅ Запрос обработан, завершаем");
    return {
      ...state,
      nextStep: "end"
    };
  }

  if (state.queryType === "simple") {
    console.log("⚡ Переходим к простой обработке");
    return {
      ...state,
      nextStep: "simple"
    };
  }

  if (state.queryType === "complex") {
    console.log("🧠 Переходим к сложной обработке");
    return {
      ...state,
      nextStep: "complex"
    };
  }

  // normal и прочие — обрабатываем как простой запрос
  console.log("📝 Переходим к обычной обработке");
  return {
    ...state,
    nextStep: "simple"
  };
}

// --- Сборка графа: узлы и рёбра ---
// START → validate → decide → (process_simple | process_complex | fallback | end)
// process_simple / process_complex ведут обратно в decide для проверки готовности
const workflow = new StateGraph(ConditionalGraphState)
  .addNode("validate", validateQuery)
  .addNode("process_simple", processSimpleQuery)
  .addNode("process_complex", processComplexQuery)
  .addNode("fallback", fallbackProcessor)
  .addNode("decide", decideNextStep)

  .addEdge(START, "validate")
  .addEdge("validate", "decide")

  .addConditionalEdges(
    "decide",
    (state) => state.nextStep,
    {
      simple: "process_simple",
      complex: "process_complex",
      fallback: "fallback",
      end: END
    }
  )

  .addEdge("process_simple", "decide")
  .addEdge("process_complex", "decide")
  .addEdge("fallback", END);

// Компиляция графа в исполняемое приложение
const app = workflow.compile();

// --- Запуск графа с одним запросом ---
async function runConditionalGraph(query) {
  console.log("🚀 Запускаю условный граф LangGraph...");

  const initialState = {
    userQuery: query,
    response: "",
    messages: [],
    queryType: "",
    confidence: 0,
    error: null,
    retryCount: 0,
    fallbackUsed: false,
    metadata: {
      startedAt: new Date().toISOString()
    }
  };

  try {
    const result = await app.invoke(initialState);

    console.log("✅ Условный граф выполнен успешно!");
    return result;

  } catch (error) {
    console.error("❌ Ошибка при выполнении условного графа:", error);
    throw error;
  }
}

// --- Точка входа: тестовые запросы или один запрос из аргумента CLI ---
async function main() {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("❌ OPENAI_API_KEY не найден в переменных окружения");
    }

    console.log("🎓 Условный граф LangGraph");
    console.log("=".repeat(50));

    // Если передан аргумент — один запрос из CLI, иначе набор тестовых
    const queryFromCli = process.argv[2];
    const testQueries = queryFromCli
      ? [queryFromCli]
      : [
        "Что такое машинное обучение?",
        "Проведи детальный анализ влияния искусственного интеллекта на современную экономику и сравни с предыдущими технологическими революциями",
        "У меня ошибка в коде, не работает",
        "Расскажи о последних новостях в IT"
      ];

    for (const query of testQueries) {
      console.log(`\n📝 Запрос: ${query}`);
      console.log("⏳ Обрабатываю...");

      const result = await runConditionalGraph(query);

      console.log("✅ Результат:");
      console.log("-".repeat(40));
      console.log(result.response);
      console.log("-".repeat(40));
      console.log(`📊 Тип запроса: ${result.queryType}`);
      console.log(`🎯 Уверенность: ${(result.confidence * 100).toFixed(1)}%`);
      console.log(`🛟 Fallback использован: ${result.fallbackUsed ? 'Да' : 'Нет'}`);
      if (result.error) {
        console.log(`❌ Ошибка: ${result.error}`);
      }
      console.log(`💬 Сообщений: ${result.messages.length}`);
    }

  } catch (error) {
    console.error("❌ Критическая ошибка:", error.message);
  }
}

// Запуск при прямом вызове файла (node index.js [ "запрос" ])
// На Windows путь может быть с обратными слэшами — нормализуем для сравнения
const isMainModule = path.resolve(process.argv[1] || "") === path.resolve(__filename);
if (isMainModule) {
  main();
}

export { runConditionalGraph, app, ConditionalGraphState };

