"""Конфигурация клиента OpenRouter API для Python.

Отредактируйте значения под свой ключ и окружение.
"""

# API-ключ OpenRouter
API_KEY: str = ""

# Базовый URL OpenRouter API
BASE_URL: str = "https://openrouter.ai/api/v1"

# Имя модели для генерации картинок по умолчанию.
# Доступные модели (на момент создания):
# - "google/gemini-2.5-flash-image-preview" (основная модель для генерации картинок через chat/completions)
# 
# Вы можете искать другие модели на https://openrouter.ai/models?m=image
# Обратите внимание: для других моделей параметры (например, aspect_ratio) могут отличаться.
MODEL: str = "google/gemini-2.5-flash-image-preview"

# Аспект по умолчанию.
# Поддерживаемые значения для Gemini:
# "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "4:5", "5:4", "21:9"
DEFAULT_ASPECT: str = "1:1"

# Таймаут для HTTP-запросов (секунды)
HTTP_TIMEOUT: int = 60
