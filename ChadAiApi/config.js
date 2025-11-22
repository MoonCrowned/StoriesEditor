export const CHAD_AI_CONFIG = {
    apiKey: 'chad-343560cee4da4e8facc398baba42b51f4cw229wz',
    // Фронтенд ходит на локальный прокси, который в свою очередь обращается к https://chadgpt.ru
    baseUrl: 'http://127.0.0.1:8100',
    // Пути эндпоинтов для генерации и проверки статуса (уточните по документации Chad Image API)
    imageGeneratePath: '/api/image/generate',
    imageStatusPath: '/api/image/status',

    // Модель по умолчанию для генерации картинок (уточните по документации)
    model: 'gpt-img-high',
    //model: 'gemini-2.5-flash-image',

    // Аспект по умолчанию, если явно не передан
    defaultAspect: '9:16',

    // Параметры ожидания результата генерации
    pollIntervalMs: 2000,
    maxWaitMs: 60000,

    // Конфигурация заголовка авторизации (при необходимости скорректируйте под реальное API)
    authHeaderName: 'Authorization',
    authHeaderPrefix: 'Bearer '
};
