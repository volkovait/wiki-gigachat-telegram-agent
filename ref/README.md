# README: 2-conditional-graph — условный граф LangGraph

## Как запускать

Результат всегда можно проверить через терминал из каталога `2-conditional-graph`:

```bash
# Установка зависимостей (один раз)
npm install

# Запуск с тестовыми запросами (4 примера)
npm start
# или
node index.js

# Запуск с одним своим запросом (аргумент командной строки)
node index.js "Что такое машинное обучение?"
node index.js "Проведи анализ трендов в IT"
```

Переменная окружения `PERPLEXITY_API_KEY` должна быть задана (файл `../.env` или экспорт в shell).

### Шаг 1: Схема состояния графа (строки 14-24)
```javascript
const ConditionalGraphState = z.object({
  userQuery: z.string().default(""),
  response: z.string().default(""),
  messages: z.array(z.any()).default([]),
  queryType: z.string().default(""), // Тип запроса
  confidence: z.number().default(0), // Уверенность в ответе
  error: z.string().nullable().default(null), // Ошибка
  retryCount: z.number().default(0), // Количество попыток
  fallbackUsed: z.boolean().default(false), // Использовался ли fallback
  nextStep: z.string().default(""), // Следующий шаг
  metadata: z.record(z.any()).default({})
});
```

**Что происходит:**
- Описывается схема состояния графа (Zod) с полями для запроса, ответа, сообщений и условной логики
- Поля для отслеживания ошибок, повторов и использования fallback

### Шаг 2: Узел валидации запроса (строки 26-71)
```javascript
async function validateQuery(state) {
  const query = state.userQuery.toLowerCase();
  
  // Простые запросы (короткие, общие вопросы)
  if (query.length < 50 && (
    query.includes("что такое") || 
    query.includes("кто такой")
  )) {
    return { ...state, queryType: "simple", confidence: 0.9 };
  }
  
  // Сложные запросы (длинные, требующие анализа)
  if (query.length > 100 || query.includes("анализ")) {
    return { ...state, queryType: "complex", confidence: 0.7 };
  }
  
  // Запросы с ошибками
  if (query.includes("ошибка") || query.includes("проблема")) {
    return { ...state, queryType: "error", confidence: 0.5 };
  }
  
  // Обычные запросы — по умолчанию
  return { ...state, queryType: "normal", confidence: 0.8 };
}
```

**Что происходит:**
1. **Анализ запроса:** Проверяется длина и содержимое запроса
2. **Классификация:** Запрос классифицируется как simple/complex/error/normal
3. **Установка уверенности:** Устанавливается уровень уверенности в ответе
4. **Возврат состояния:** Обновляется состояние с типом запроса

### Шаг 3: Узел обработки простых запросов (строки 73-115)
```javascript
async function processSimpleQuery(state) {
  const model = new ChatPerplexity({
    model: "sonar",
    temperature: 0.3, // Низкая температура для точности
    maxTokens: 300,
    apiKey: process.env.PERPLEXITY_API_KEY,
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
      confidence: 0.9
    };
  } catch (error) {
    return { ...state, error: error.message, confidence: 0.1 };
  }
}
```

**Что происходит:**
1. **Создание модели:** Инициализируется ChatPerplexity с низкой температурой
2. **Создание промпта:** Создается промпт для кратких ответов
3. **Выполнение запроса:** Обрабатывается запрос через API
4. **Обработка результата:** Создаются сообщения и обновляется состояние
5. **Обработка ошибок:** В случае ошибки возвращается состояние с ошибкой

### Шаг 4: Узел обработки сложных запросов (строки 117-160)
```javascript
async function processComplexQuery(state) {
  const model = new ChatPerplexity({
    model: "sonar",
    temperature: 0.7, // Высокая температура для креативности
    maxTokens: 800,
    apiKey: process.env.PERPLEXITY_API_KEY,
  });
  
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", "Проведи детальный анализ и дай развернутый ответ на русском языке."],
    ["human", "{query}"]
  ]);
  
  // Аналогично простой обработке, но с другими параметрами
}
```

**Что происходит:**
- Аналогично простой обработке, но с другими параметрами модели
- Используется более высокая температура и больше токенов
- Промпт настроен на детальный анализ

### Шаг 5: Fallback-узел (строки 162-185)
```javascript
async function fallbackProcessor(state) {
  const fallbackResponse = `Извините, у меня возникли проблемы с обработкой вашего запроса: "${state.userQuery}". 
  
Попробуйте переформулировать вопрос или обратитесь в техническую поддержку.`;

  const userMessage = new HumanMessage(state.userQuery);
  const aiMessage = new AIMessage(fallbackResponse);
  return {
    ...state,
    response: fallbackResponse,
    messages: [...state.messages, userMessage, aiMessage],
    fallbackUsed: true,
    confidence: 0.3
  };
}
```

**Что происходит:**
1. **Создание fallback ответа:** Формируется стандартное сообщение об ошибке
2. **Создание сообщений:** Создаются HumanMessage и AIMessage для истории
3. **Обновление состояния:** Устанавливается fallbackUsed: true

### Шаг 6: Узел принятия решений (строки 187-227)
```javascript
function decideNextStep(state) {
  // Если есть ошибка, используем fallback
  if (state.error) {
    return { ...state, nextStep: "fallback" };
  }
  
  // Если запрос уже обработан, завершаем
  if (state.response && state.response.length > 10) {
    return { ...state, nextStep: "end" };
  }
  
  // Если это простой запрос, обрабатываем как простой
  if (state.queryType === "simple") {
    return { ...state, nextStep: "simple" };
  }
  
  // Если это сложный запрос, обрабатываем как сложный
  if (state.queryType === "complex") {
    return { ...state, nextStep: "complex" };
  }
  
  return { ...state, nextStep: "simple" };
}
```

**Что происходит:**
1. **Проверка ошибок:** Если есть ошибка, переходим к fallback
2. **Проверка завершения:** Если ответ готов, завершаем
3. **Выбор стратегии:** Выбираем стратегию обработки на основе типа запроса
4. **Возврат решения:** Возвращается состояние с nextStep

### Шаг 7: Создание графа с условными рёбрами (строки 229-252)
```javascript
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
```

**Что происходит:**
1. **Добавление узлов:** Регистрируются все узлы графа
2. **Начальные переходы:** START → validate → decide
3. **Условные переходы:** От decide к разным процессорам на основе nextStep
4. **Обратные переходы:** От процессоров обратно к decide
5. **Завершающие переходы:** fallback → END

### Шаг 8: Компиляция и запуск (строки 254-284)
```javascript
const app = workflow.compile();

async function runConditionalGraph(query) {
  const initialState = {
    userQuery: query,
    response: "",
    messages: [],
    queryType: "",
    confidence: 0,
    error: null,
    retryCount: 0,
    fallbackUsed: false,
    metadata: { startedAt: new Date().toISOString() }
  };
  
  const result = await app.invoke(initialState);
  return result;
}
```

**Что происходит:**
1. **Компиляция графа:** Граф компилируется в исполняемый объект
2. **Создание начального состояния:** Формируется состояние с начальными значениями
3. **Выполнение графа:** Вызывается app.invoke(initialState)
4. **Возврат результата:** Возвращается финальное состояние

## Поток выполнения данных

```
1. main() или CLI → формируется запрос (тестовый или из аргумента)
2. runConditionalGraph(query) → создаётся initialState
3. app.invoke(initialState) → запуск графа
4. START → validate → validateQuery(state)
5. validate → decide → decideNextStep(state)
6. decide → process_simple | process_complex | fallback | end (по значению nextStep)
7. process_simple / process_complex → decide → снова decideNextStep(state)
8. decide → END (если ответ готов) или переход к соответствующему процессору
```

## Условная логика

### Типы переходов:
1. **Простые переходы:** `addEdge(from, to)`
2. **Условные переходы:** `addConditionalEdges(node, condition, mapping)`

### Условия переходов (значения nextStep):
- **simple** → узел process_simple
- **complex** → узел process_complex
- **fallback** → узел fallback (при ошибке или запросе типа "error")
- **end** → завершение графа (когда ответ уже получен)

## Структура состояния

**Входное состояние:**
```javascript
{
  userQuery: "Что такое ИИ?",
  response: "",
  messages: [],
  queryType: "",
  confidence: 0,
  error: null,
  retryCount: 0,
  fallbackUsed: false,
  nextStep: "",
  metadata: { startedAt: "2024-01-01T10:00:00.000Z" }
}
```

**Промежуточное состояние (после валидации):**
```javascript
{
  userQuery: "Что такое ИИ?",
  queryType: "simple",
  confidence: 0.9,
  nextStep: "simple",
  // ... остальные поля
}
```

**Выходное состояние:**
```javascript
{
  userQuery: "Что такое ИИ?",
  response: "Искусственный интеллект - это...",
  messages: [HumanMessage, AIMessage],
  queryType: "simple",
  confidence: 0.9,
  fallbackUsed: false,
  // ... остальные поля
}
```

## Ключевые особенности

1. **Условная логика:** Разные пути обработки в зависимости от типа запроса
2. **Обработка ошибок:** Fallback механизм при ошибках
3. **Retry-логика:** Поле retryCount для возможных повторных попыток
4. **Мониторинг:** Отслеживание уверенности и качества
5. **Гибкость:** Легко добавлять новые типы запросов и стратегии

