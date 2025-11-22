import { GPT_IMAGE_CONFIG } from './config.js';

async function hashPromptToHex(prompt) {
    const encoder = new TextEncoder();
    const data = encoder.encode(prompt + '|' + Date.now() + '|' + Math.random());
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

async function callGptImageApi(prompt, overrideOptions = {}) {
    const cfg = GPT_IMAGE_CONFIG || {};
    if (!cfg.apiKey) {
        throw new Error('GPT_Image_API: apiKey is not set in config.js');
    }

    const apiBaseUrl = cfg.apiBaseUrl || 'https://api.openai.com/v1';
    const model = overrideOptions.model || cfg.model || 'gpt-image-1';
    const size = overrideOptions.size || cfg.size || '1024x1024';

    const body = {
        model,
        prompt,
        n: 1,
        size
    };

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`
    };

    if (cfg.organization) {
        headers['OpenAI-Organization'] = cfg.organization;
    }
    if (cfg.project) {
        headers['OpenAI-Project'] = cfg.project;
    }
    const endpoint = apiBaseUrl.replace(/\/$/, '') + '/images/generations';

    console.log('GPT_Image_API request', {
        endpoint,
        body
    });

    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        let text = '';
        try {
            text = await response.text();
        } catch (e) {
            // ignore
        }
        console.error('GPT_Image_API HTTP error', {
            status: response.status,
            statusText: response.statusText,
            bodyText: text
        });
        throw new Error(`GPT_Image_API: HTTP ${response.status} ${response.statusText}: ${text}`);
    }

    const json = await response.json();
    console.log('GPT_Image_API response json', json);
    const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
    if (!b64) {
        throw new Error('GPT_Image_API: empty image data in response');
    }

    return base64ToUint8Array(b64);
}

export async function generateImageToImagesDir(prompt, rootDirHandle, options = {}) {
    if (!prompt || typeof prompt !== 'string') {
        throw new Error('GPT_Image_API: prompt must be a non-empty string');
    }
    if (!rootDirHandle || typeof rootDirHandle.getDirectoryHandle !== 'function') {
        throw new Error('GPT_Image_API: rootDirHandle must be a FileSystemDirectoryHandle');
    }

    const extension = options.extension || 'png';

    const imagesDir = await rootDirHandle.getDirectoryHandle('Images', { create: true });

    const hexName = await hashPromptToHex(prompt);
    const fileName = `${hexName}.${extension}`;

    const imageBytes = await callGptImageApi(prompt, options);

    const fileHandle = await imagesDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(imageBytes);
    await writable.close();

    return {
        fileName,
        subdir: 'Images',
        relativePath: `Images/${fileName}`,
        fileHandle
    };
}

// Дополнительно публикуем объект сервиса в window для простого использования из обычных скриптов
if (typeof window !== 'undefined') {
    window.GptImageService = {
        generateImageToImagesDir
    };
}
