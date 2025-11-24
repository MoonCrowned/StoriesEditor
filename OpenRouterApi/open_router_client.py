import asyncio
import base64
import hashlib
import json
import time
from pathlib import Path
from typing import Optional
import urllib.error
import urllib.request

from . import config


class OpenRouterError(Exception):
    """Исключение, выбрасываемое клиентом OpenRouter API."""


def _normalize_aspect_for_openrouter(aspect: Optional[str]) -> str:
    """Приводит аспект к допустимому формату (если требуется).
    Для Gemini поддерживаются: 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 4:5, 5:4, 21:9.
    Если аспект не распознан, возвращает '1:1' или исходный, если он похож на правду.
    """
    raw = str(aspect or getattr(config, "DEFAULT_ASPECT", "1:1"))
    
    # Список известных поддерживаемых аспектов
    known = {
        "1:1", "3:2", "2:3", "4:3", "3:4", 
        "16:9", "9:16", "4:5", "5:4", "21:9"
    }
    
    if raw in known:
        return raw

    # Простая эвристика для неизвестных форматов, 
    # можно попробовать оставить как есть или привести к ближайшему.
    # Пока оставим логику "если похоже на N:M, пробуем отправить, иначе 1:1"
    parts = raw.split(":")
    if len(parts) == 2:
        if parts[0].isdigit() and parts[1].isdigit():
            return raw
            
    return "1:1"


def _hash_prompt_to_hex(value: str, length: int = 16) -> str:
    """Хеширует строку в SHA-256 и возвращает первые length байт в hex."""
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    digest = digest[:length]
    return "".join(f"{b:02x}" for b in digest)


def _ensure_config() -> None:
    if not getattr(config, "API_KEY", None):
        raise OpenRouterError("OpenRouterApi: API_KEY is not set in config.py")


def _request_json_sync(url: str, body: dict, api_key: str) -> dict:
    """Синхронный HTTP-запрос к OpenRouter."""
    data_bytes = json.dumps(body).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "HTTP-Referer": "https://github.com/MoonCrowned/StoriesEditor", # Optional: Good practice for OpenRouter
        "X-Title": "StoriesEditor" # Optional
    }

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method="POST")

    try:
        # Увеличиваем таймаут для генерации изображений
        timeout = getattr(config, "HTTP_TIMEOUT", 60)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.getcode()
            raw = resp.read()
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read() or str(e).encode("utf-8")
    except urllib.error.URLError as e:
        raise OpenRouterError(f"OpenRouterApi: network error while calling {url}: {e}") from e

    text = raw.decode("utf-8", errors="replace")
    if not (200 <= status < 300):
        raise OpenRouterError(f"OpenRouterApi: HTTP {status} for {url}: {text}")

    if not text.strip():
        return {}

    try:
        return json.loads(text)
    except Exception as e:
        raise OpenRouterError("OpenRouterApi: invalid JSON in response") from e


async def _request_json(url: str, body: dict, api_key: str) -> dict:
    return await asyncio.to_thread(_request_json_sync, url, body, api_key)


async def generate_image_bytes(
    prompt: str, 
    aspect: Optional[str] = None, 
    model: Optional[str] = None
) -> bytes:
    """Асинхронно генерирует картинку и возвращает байты."""
    _ensure_config()
    
    if not prompt or not isinstance(prompt, str):
        raise OpenRouterError("OpenRouterApi: prompt must be a non-empty string")

    # Определение модели
    target_model = model
    if not target_model:
        target_model = getattr(config, "MODEL", "google/gemini-2.5-flash-image-preview")

    # Определение аспекта
    aspect_ratio = _normalize_aspect_for_openrouter(aspect)

    base_url = (getattr(config, "BASE_URL", "") or "https://openrouter.ai/api/v1").rstrip("/")
    url = f"{base_url}/chat/completions"
    api_key = getattr(config, "API_KEY", "")

    # Формирование тела запроса
    # Для Gemini и других моделей OpenRouter для картинок используем modalities + image_config
    payload = {
        "model": target_model,
        "messages": [
            {
                "role": "user",
                "content": prompt
            }
        ],
        # Это ключевой параметр для генерации изображений в OpenRouter
        "modalities": ["image", "text"],
        "image_config": {
            "aspect_ratio": aspect_ratio
        }
    }

    json_resp = await _request_json(url, payload, api_key)

    # Разбор ответа
    # Ожидаем структуру: choices[0].message.images[0].image_url.url (data:image/png;base64,...)
    choices = json_resp.get("choices", [])
    if not choices:
        raise OpenRouterError(f"OpenRouterApi: no choices in response: {json_resp}")

    message = choices[0].get("message", {})
    images = message.get("images", [])
    
    if not images:
        # Иногда может вернуться отказ или текст, если модель не может сгенерировать
        content = message.get("content", "")
        raise OpenRouterError(f"OpenRouterApi: no images generated. Response content: {content}")

    # Берем первую картинку
    image_obj = images[0]
    image_url_data = image_obj.get("image_url", {}).get("url", "")

    if not image_url_data.startswith("data:"):
        # Если это ссылка (http), то нужно скачать. Пока реализуем base64 data URI, как в документации Gemini.
        if image_url_data.startswith("http"):
             return await asyncio.to_thread(_download_bytes_sync, image_url_data)
        raise OpenRouterError("OpenRouterApi: unsupported image URL format (expected data URI or http URL)")

    # Парсинг data URI
    # data:image/png;base64,.....
    try:
        header, encoded = image_url_data.split(",", 1)
        return base64.b64decode(encoded)
    except Exception as e:
        raise OpenRouterError("OpenRouterApi: failed to decode base64 image data") from e


def _download_bytes_sync(url: str) -> bytes:
    try:
        timeout = getattr(config, "HTTP_TIMEOUT", 60)
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.read()
    except Exception as e:
        raise OpenRouterError(f"OpenRouterApi: failed to download image from {url}: {e}") from e


async def generate_image_to_file(
    prompt: str,
    aspect: Optional[str] = None,
    directory: Optional[Path | str] = None,
    extension: str = "png",
    model: Optional[str] = None
) -> Path:
    """Генерирует картинку и сохраняет её в файл.

    :param prompt: текстовый промпт
    :param aspect: соотношение сторон (напр. "16:9")
    :param directory: папка для сохранения (по умолчанию OpenRouterApi/Images)
    :param extension: расширение файла (png, jpg)
    :param model: модель (если None, берется из config.py)
    :return: путь к сохраненному файлу
    """
    if directory is None:
        directory = Path(__file__).resolve().parent / "Images"
    else:
        directory = Path(directory)

    directory.mkdir(parents=True, exist_ok=True)

    aspect_raw = str(aspect if aspect else getattr(config, "DEFAULT_ASPECT", "1:1"))

    # Генерируем байты
    image_bytes = await generate_image_bytes(prompt, aspect, model=model)

    # Формируем имя файла
    # Добавляем модель в хеш, чтобы при смене модели менялся хеш?
    # Chad не добавлял модель в хеш, но тут модель может меняться динамически.
    # Лучше добавить, или просто оставить prompt+aspect.
    # Пользователь просил "в том же виде". В Chad хеш был от prompt|aspect.
    # Оставим prompt|aspect для совместимости логики именования.
    hex_name = _hash_prompt_to_hex(f"{prompt}|{aspect_raw}")
    ext = (extension or "png").lstrip(".")
    file_name = f"{hex_name}.{ext}"
    file_path = directory / file_name

    file_path.write_bytes(image_bytes)

    return file_path
