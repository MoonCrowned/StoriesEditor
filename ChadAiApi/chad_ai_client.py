import asyncio
import base64
import hashlib
import time
from pathlib import Path
from typing import Optional

from . import config


class ChadAiError(Exception):
    """Исключение, выбрасываемое клиентом Chad AI Image API."""


def _normalize_aspect_for_chad(aspect: Optional[str]) -> str:
    """Приводит аспект к одному из допустимых значений для Chad: '1:1', '3:2', '2:3'."""
    allowed = {"1:1", "3:2", "2:3"}
    raw = str(aspect or getattr(config, "DEFAULT_ASPECT", "1:1"))

    if raw in allowed:
        return raw

    parts = raw.split(":", 1)
    if len(parts) == 2:
        try:
            w = float(parts[0])
            h = float(parts[1])
        except ValueError:
            return "1:1"
        if w > 0 and h > 0:
            ratio = w / h
            if abs(ratio - 1.0) < 0.15:
                return "1:1"
            if ratio > 1.0:
                return "3:2"
            return "2:3"

    return "1:1"


def _hash_prompt_to_hex(value: str, length: int = 16) -> str:
    """Хеширует строку в SHA-256 и возвращает первые length байт в hex.

    Совместимо по логике с hashPromptToHex из JS-клиента.
    """
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    digest = digest[:length]
    return "".join(f"{b:02x}" for b in digest)


def _base_url() -> str:
    base = (getattr(config, "BASE_URL", "") or "").rstrip("/")
    if not base:
        raise ChadAiError("ChadAiApi: BASE_URL is not configured in config.py")
    return base


def _ensure_config() -> None:
    if not getattr(config, "API_KEY", None):
        raise ChadAiError("ChadAiApi: API_KEY is not set in config.py")
    if not getattr(config, "MODEL", None):
        raise ChadAiError("ChadAiApi: MODEL is not set in config.py")


def _request_json_sync(method: str, url: str, body: Optional[dict]) -> dict:
    """Синхронный HTTP-запрос, ожидающий JSON-ответ."""
    import json
    import urllib.error
    import urllib.request

    data_bytes = None
    headers = {}
    if body is not None:
        data_bytes = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=getattr(config, "HTTP_TIMEOUT", 60)) as resp:
            status = resp.getcode()
            raw = resp.read()
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read() or str(e).encode("utf-8")
    except urllib.error.URLError as e:
        raise ChadAiError(f"ChadAiApi: network error while calling {url}: {e}") from e

    text = raw.decode("utf-8", errors="replace")
    if not (200 <= status < 300):
        raise ChadAiError(f"ChadAiApi: HTTP {status} for {url}: {text}")

    if not text.strip():
        return {}

    try:
        return json.loads(text)
    except Exception as e:  # json.JSONDecodeError может отсутствовать в старых версиях
        raise ChadAiError("ChadAiApi: invalid JSON in response") from e


async def _request_json(method: str, url: str, body: Optional[dict]) -> dict:
    return await asyncio.to_thread(_request_json_sync, method, url, body)


def _download_bytes_sync(url: str) -> bytes:
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(url, timeout=getattr(config, "HTTP_TIMEOUT", 60)) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        data = e.read() or str(e).encode("utf-8")
        msg = data.decode("utf-8", errors="replace")
        raise ChadAiError(f"ChadAiApi: HTTP {e.code} while downloading image: {msg}") from e
    except urllib.error.URLError as e:
        raise ChadAiError(f"ChadAiApi: network error while downloading image: {e}") from e


async def _download_bytes(url: str) -> bytes:
    return await asyncio.to_thread(_download_bytes_sync, url)


async def _start_image_generation(prompt: str, aspect_raw: str) -> tuple[dict, Optional[str]]:
    """Запускает генерацию картинки и возвращает (JSON-ответ, content_id или None)."""
    _ensure_config()
    base_url = _base_url()
    aspect_ratio = _normalize_aspect_for_chad(aspect_raw)

    url = f"{base_url}/api/public/{config.MODEL}/imagine"
    body = {
        "prompt": str(prompt),
        "api_key": getattr(config, "API_KEY", None),
        "aspect_ratio": aspect_ratio,
    }

    json_resp = await _request_json("POST", url, body)

    content_id = (
        json_resp.get("content_id")
        or json_resp.get("contentId")
        or (json_resp.get("data") or {}).get("content_id")
    )

    return json_resp, content_id


async def _extract_image_bytes_from_json(json_resp: dict, base_url: str) -> Optional[bytes]:
    """Пытается вытащить байты картинки из JSON-ответа (base64 или URL)."""
    # Вариант 1: картинка сразу приходит в base64
    b64 = json_resp.get("image_base64")
    data = json_resp.get("data") or {}
    if not b64 and isinstance(data, dict):
        b64 = data.get("image_base64")

    if isinstance(b64, str):
        try:
            return base64.b64decode(b64)
        except Exception as e:  # некорректный base64
            raise ChadAiError("ChadAiApi: failed to decode base64 image data") from e

    # Вариант 2: ссылка на картинку
    image_url: Optional[str] = None
    output = json_resp.get("output")
    if isinstance(output, list) and output and isinstance(output[0], str):
        image_url = output[0]

    if not image_url:
        image_url = json_resp.get("image_url") or json_resp.get("url")
        if not image_url and isinstance(data, dict):
            image_url = data.get("url")

    if image_url and isinstance(image_url, str):
        from urllib.parse import urlparse

        parsed = urlparse(image_url)
        if not parsed.scheme:
            # относительный URL -> достраиваем от BASE_URL
            download_url = f"{base_url.rstrip('/')}/{image_url.lstrip('/')}"
        else:
            download_url = image_url

        return await _download_bytes(download_url)

    return None


async def _wait_for_image_content(content_id: str) -> bytes:
    """Ожидает завершения генерации и возвращает байты картинки."""
    base_url = _base_url()
    poll_interval = getattr(config, "POLL_INTERVAL_MS", 2000)
    max_wait = getattr(config, "MAX_WAIT_MS", 60000)

    url = f"{base_url}/api/public/check"
    started = time.monotonic()

    while True:
        if (time.monotonic() - started) * 1000 > max_wait:
            raise ChadAiError("ChadAiApi: timeout while waiting for image generation to complete")

        body = {
            "api_key": getattr(config, "API_KEY", None),
            "content_id": content_id,
        }

        json_resp = await _request_json("GET", url, body)

        status = str(json_resp.get("status") or json_resp.get("state") or "").lower()

        if status in {"pending", "processing", "queued", "running"}:
            await asyncio.sleep(poll_interval / 1000.0)
            continue

        if status in {"failed", "cancelled"}:
            code = json_resp.get("error_code") or json_resp.get("code") or "no-code"
            msg = json_resp.get("error_message") or json_resp.get("message") or "Unknown error"
            raise ChadAiError(f"ChadAiApi: generation {status} ({code}): {msg}")

        if status and status not in {"ready", "done", "completed"}:
            raise ChadAiError(f"ChadAiApi: generation finished with unexpected status '{status}'")

        image_bytes = await _extract_image_bytes_from_json(json_resp, base_url)
        if image_bytes is not None:
            return image_bytes

        raise ChadAiError("ChadAiApi: status indicates completion but no image data found in response")


async def generate_image_bytes(prompt: str, aspect: Optional[str] = None) -> bytes:
    """Асинхронно генерирует картинку по промпту и возвращает сырые байты.

    :param prompt: текстовый промпт
    :param aspect: строка вида "1:1", "3:2", "2:3", "9:16" и т.п.
    :return: байты изображения (обычно PNG/JPEG)
    """
    if not isinstance(prompt, str) or not prompt.strip():
        raise ChadAiError("ChadAiApi: prompt must be a non-empty string")

    if aspect is None:
        aspect = getattr(config, "DEFAULT_ASPECT", "1:1")

    aspect_raw = str(aspect)

    start_json, content_id = await _start_image_generation(prompt, aspect_raw)

    if content_id:
        return await _wait_for_image_content(content_id)

    base_url = _base_url()
    image_bytes = await _extract_image_bytes_from_json(start_json, base_url)
    if image_bytes is None:
        raise ChadAiError(
            "ChadAiApi: cannot determine image bytes from generation response; "
            "check API docs and adjust client."
        )

    return image_bytes


async def generate_image_to_file(
    prompt: str,
    aspect: Optional[str] = None,
    directory: Optional[Path | str] = None,
    extension: str = "png",
) -> Path:
    """Генерирует картинку и сохраняет её в файл.

    :param prompt: текстовый промпт
    :param aspect: аспект (см. generate_image_bytes)
    :param directory: каталог для сохранения. Если None, используется
        подкаталог "Images" рядом с этим модулем (ChadAiApi/Images).
    :param extension: расширение файла ("png", "jpg" и т.п.)
    :return: путь к созданному файлу (Path)
    """
    if directory is None:
        directory = Path(__file__).resolve().parent / "Images"
    else:
        directory = Path(directory)

    directory.mkdir(parents=True, exist_ok=True)

    if aspect is None:
        aspect = getattr(config, "DEFAULT_ASPECT", "1:1")

    aspect_raw = str(aspect)

    image_bytes = await generate_image_bytes(prompt, aspect_raw)

    hex_name = _hash_prompt_to_hex(f"{prompt}|{aspect_raw}")
    ext = (extension or "png").lstrip(".")
    file_name = f"{hex_name}.{ext}"
    file_path = directory / file_name

    file_path.write_bytes(image_bytes)

    return file_path
