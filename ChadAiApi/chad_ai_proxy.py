import http.server
import socketserver
import urllib.request
import urllib.error
import urllib.parse
import json
import sys

# Конфигурация прокси
PROXY_HOST = '127.0.0.1'
PROXY_PORT = 8100
REMOTE_BASE_URL = 'https://ask.chadgpt.ru'

ALLOWED_ORIGIN = '*'


class ChadAiProxyHandler(http.server.BaseHTTPRequestHandler):
    def _send_cors_headers(self, status_code=200, content_type='application/json'):
        self.send_response(status_code)
        self.send_header('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Content-Type', content_type)
        self.end_headers()

    def do_OPTIONS(self):
        # Preflight запросы CORS
        self._send_cors_headers(200)

    def do_POST(self):
        # Для /api/public/check Chad ожидает GET, но с JSON-телом.
        # Браузер не может отправить GET с body, поэтому принимаем POST
        # и проксируем его как GET с тем же телом.
        if self.path.startswith('/api/public/check'):
            self._handle_proxy_request(method='GET')
        elif self.path.startswith('/api/public/'):
            self._handle_proxy_request(method='POST')
        else:
            self._send_cors_headers(404)
            self.wfile.write(b'{"error":"not_found"}')

    def do_GET(self):
        if self.path.startswith('/api/public/'):
            self._handle_proxy_request(method='GET')
        elif self.path.startswith('/download-image'):
            self._handle_download_image()
        else:
            self._send_cors_headers(404)
            self.wfile.write(b'{"error":"not_found"}')

    def log_message(self, format, *args):
        # Упрощённый лог в stdout
        sys.stdout.write("[ChadAiProxy] " + (format % args) + "\n")

    def _handle_proxy_request(self, method: str):
        # Читаем тело запроса (если есть)
        body = None
        # Читаем тело, если клиент прислал POST (даже если мы дальше шлём GET)
        if self.command == 'POST':
            content_length = int(self.headers.get('Content-Length', '0') or '0')
            if content_length > 0:
                body = self.rfile.read(content_length)

        remote_url = REMOTE_BASE_URL.rstrip('/') + self.path

        # Пробрасываем только нужные заголовки
        forward_headers = {}
        auth = self.headers.get('Authorization')
        if auth:
            forward_headers['Authorization'] = auth
        content_type = self.headers.get('Content-Type')
        if content_type:
            forward_headers['Content-Type'] = content_type

        # IMPORTANT: пробрасываем body и для GET, и для POST.
        # Chad Image Check ожидает GET с JSON-телом, поэтому нельзя терять body.
        req = urllib.request.Request(remote_url, data=body, headers=forward_headers, method=method)

        try:
            with urllib.request.urlopen(req) as resp:
                resp_body = resp.read()
                status_code = resp.getcode()
                resp_content_type = resp.headers.get('Content-Type', 'application/json')
        except urllib.error.HTTPError as e:
            # Пробрасываем HTTP-ошибку от Chad как есть, но с CORS-заголовками
            resp_body = e.read() or str(e).encode('utf-8')
            status_code = e.code
            resp_content_type = e.headers.get('Content-Type', 'application/json') if e.headers else 'application/json'
        except urllib.error.URLError as e:
            # Ошибка сети или DNS при обращении к Chad
            self._send_cors_headers(502)
            error_body = json.dumps({
                'error': 'proxy_request_failed',
                'detail': str(e)
            }).encode('utf-8')
            self.wfile.write(error_body)
            return

        # Успешный ответ или HTTPError от Chad: возвращаем его клиенту с CORS-заголовками
        self._send_cors_headers(status_code, content_type=resp_content_type)
        self.wfile.write(resp_body)

    def _handle_download_image(self):
        # Скачиваем картинку по удалённому URL и отдаём байты с CORS-заголовками
        try:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            url_list = qs.get('url')
            if not url_list:
                self._send_cors_headers(400)
                self.wfile.write(json.dumps({'error': 'missing_url'}).encode('utf-8'))
                return

            target_url = url_list[0]

            with urllib.request.urlopen(target_url) as resp:
                data = resp.read()
                content_type = resp.headers.get('Content-Type', 'application/octet-stream')

            self._send_cors_headers(200, content_type=content_type)
            self.wfile.write(data)
        except urllib.error.HTTPError as e:
            body = e.read() or str(e).encode('utf-8')
            self._send_cors_headers(e.code)
            self.wfile.write(body)
        except urllib.error.URLError as e:
            self._send_cors_headers(502)
            self.wfile.write(json.dumps({
                'error': 'image_download_failed',
                'detail': str(e)
            }).encode('utf-8'))


def run_server():
    with socketserver.TCPServer((PROXY_HOST, PROXY_PORT), ChadAiProxyHandler) as httpd:
        print(f'ChadAi proxy server listening on http://{PROXY_HOST}:{PROXY_PORT}')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nChadAi proxy server stopping...')


if __name__ == '__main__':
    run_server()
