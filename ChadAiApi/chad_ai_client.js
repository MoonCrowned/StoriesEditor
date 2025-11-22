import { CHAD_AI_CONFIG } from './config.js';

async function hashPromptToHex(input) {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    const length = Math.min(bytes.length, 16);
    for (let i = 0; i < length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function normalizeAspectForChad(aspect, cfg) {
    const allowed = ['1:1', '3:2', '2:3'];
    let raw = (aspect || (cfg && cfg.defaultAspect) || '1:1').toString();

    if (allowed.includes(raw)) {
        return raw;
    }

    const parts = raw.split(':');
    if (parts.length === 2) {
        const w = Number(parts[0]);
        const h = Number(parts[1]);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            const ratio = w / h;
            if (Math.abs(ratio - 1) < 0.15) return '1:1';
            if (ratio > 1) return '3:2';
            return '2:3';
        }
    }

    return '1:1';
}

async function startImageGeneration(prompt, aspect) {
    const cfg = CHAD_AI_CONFIG || {};
    if (!cfg.apiKey) {
        throw new Error('ChadAiApi: apiKey is not set in config.js');
    }
    const baseUrl = (cfg.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) {
        throw new Error('ChadAiApi: baseUrl is not configured.');
    }

    const model = cfg.model;
    if (!model) {
        throw new Error('ChadAiApi: model is not set in config.js');
    }

    const url = `${baseUrl}/api/public/${encodeURIComponent(model)}/imagine`;

    const aspectRatio = normalizeAspectForChad(aspect, cfg);

    const body = {
        // Точное имя поля промта в Image API не задокументировано в этом коде,
        // но по ошибкам сервера видно, что message и лишние поля запрещены.
        // Используем минимально необходимый набор полей.
        prompt: String(prompt),
        api_key: cfg.apiKey,
        aspect_ratio: aspectRatio
    };

    const headers = {
        'Content-Type': 'application/json'
    };

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });

    const text = await response.text();
    if (!response.ok) {
        console.error('ChadAiApi HTTP error on startImageGeneration', {
            status: response.status,
            statusText: response.statusText,
            bodyText: text
        });
        throw new Error(`ChadAiApi: HTTP ${response.status} on image generation start: ${text}`);
    }

    let json = {};
    if (text) {
        try {
            json = JSON.parse(text);
        } catch (e) {
            console.error('ChadAiApi: failed to parse JSON from startImageGeneration', e);
            throw new Error('ChadAiApi: invalid JSON in image generation response');
        }
    }

    const contentId = json.content_id || json.contentId || (json.data && json.data.content_id);
    return { json, contentId };
}

async function waitForImageContent(contentId) {
    const cfg = CHAD_AI_CONFIG || {};
    const baseUrl = (cfg.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) {
        throw new Error('ChadAiApi: baseUrl is not configured.');
    }

    const pollInterval = cfg.pollIntervalMs || 2000;
    const maxWait = cfg.maxWaitMs || 60000;
    const statusPath = '/api/public/check';
    const url = `${baseUrl}${statusPath}`;
    const startedAt = Date.now();

    while (true) {
        if (Date.now() - startedAt > maxWait) {
            throw new Error('ChadAiApi: timeout while waiting for image generation to complete');
        }

        const body = {
            api_key: cfg.apiKey,
            content_id: contentId
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        const text = await response.text();

        if (!response.ok) {
            console.error('ChadAiApi HTTP error on status', {
                status: response.status,
                statusText: response.statusText,
                bodyText: text
            });
            throw new Error(`ChadAiApi: HTTP ${response.status} while checking image status: ${text}`);
        }

        let json = {};
        if (text) {
            try {
                json = JSON.parse(text);
            } catch (e) {
                console.error('ChadAiApi: failed to parse JSON from status', e);
                throw new Error('ChadAiApi: invalid JSON in status response');
            }
        }

        const status = (json.status || json.state || '').toLowerCase();

        if (status === 'pending' || status === 'processing' || status === 'queued' || status === 'running') {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            continue;
        }

        if (status === 'failed' || status === 'cancelled') {
            const code = json.error_code || json.code || 'no-code';
            const msg = json.error_message || json.message || 'Unknown error';
            throw new Error(`ChadAiApi: generation ${status} (${code}): ${msg}`);
        }

        if (status && status !== 'ready' && status !== 'done' && status !== 'completed') {
            throw new Error(`ChadAiApi: generation finished with unexpected status '${status}'`);
        }

        let b64 = json.image_base64 || (json.data && json.data.image_base64);
        if (b64 && typeof b64 === 'string') {
            return base64ToUint8Array(b64);
        }

        let imageUrl;
        if (Array.isArray(json.output) && json.output.length > 0 && typeof json.output[0] === 'string') {
            imageUrl = json.output[0];
        } else {
            imageUrl = json.image_url || json.url || (json.data && json.data.url);
        }
        if (imageUrl && typeof imageUrl === 'string') {
            const downloadUrl = `${baseUrl}/download-image?url=${encodeURIComponent(imageUrl)}`;
            const imgResp = await fetch(downloadUrl);
            if (!imgResp.ok) {
                const imgText = await imgResp.text().catch(() => '');
                console.error('ChadAiApi HTTP error while downloading image', {
                    status: imgResp.status,
                    statusText: imgResp.statusText,
                    bodyText: imgText
                });
                throw new Error(`ChadAiApi: HTTP ${imgResp.status} while downloading image: ${imgText}`);
            }
            const buf = await imgResp.arrayBuffer();
            return new Uint8Array(buf);
        }

        throw new Error('ChadAiApi: status indicates completion but no image data found in response');
    }
}

export async function generateImageToImagesDir(prompt, aspect, chadApiRootDirHandle, options = {}) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('ChadAiApi: prompt must be a non-empty string');
    }

    if (!chadApiRootDirHandle || typeof chadApiRootDirHandle.getDirectoryHandle !== 'function') {
        throw new Error('ChadAiApi: chadApiRootDirHandle must be a FileSystemDirectoryHandle');
    }

    const cfg = CHAD_AI_CONFIG || {};
    const aspectToUse = (aspect || options.aspect || cfg.defaultAspect || '1:1').toString();

    const { contentId, json: startJson } = await startImageGeneration(prompt, aspectToUse);

    let imageBytes;

    if (contentId) {
        imageBytes = await waitForImageContent(contentId);
    } else {
        let b64 = startJson.image_base64 || (startJson.data && startJson.data.image_base64);
        if (b64 && typeof b64 === 'string') {
            imageBytes = base64ToUint8Array(b64);
        } else {
            const imageUrl = startJson.image_url || startJson.url || (startJson.data && startJson.data.url);
            if (imageUrl && typeof imageUrl === 'string') {
                const resp = await fetch(imageUrl);
                if (!resp.ok) {
                    const text = await resp.text().catch(() => '');
                    throw new Error(`ChadAiApi: HTTP ${resp.status} while downloading image: ${text}`);
                }
                const buf = await resp.arrayBuffer();
                imageBytes = new Uint8Array(buf);
            }
        }

        if (!imageBytes) {
            throw new Error('ChadAiApi: cannot determine image bytes from generation response; check API docs and adjust client.');
        }
    }

    const imagesDir = await chadApiRootDirHandle.getDirectoryHandle('Images', { create: true });

    const hexName = await hashPromptToHex(`${prompt}|${aspectToUse}`);
    const extension = options.extension || 'png';
    const fileName = `${hexName}.${extension}`;

    const fileHandle = await imagesDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(imageBytes);
    await writable.close();

    const relativePath = `Images/${fileName}`;

    return {
        fileName,
        subdir: 'Images',
        relativePath,
        fileHandle
    };
}

if (typeof window !== 'undefined') {
    window.ChadAiImageService = {
        generateImageToImagesDir
    };
}
