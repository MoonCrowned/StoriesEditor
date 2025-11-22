// Basic skeleton for story editor SPA

import { generateImageToImagesDir as generateChadImageToImagesDir } from './ChadAiApi/chad_ai_client.js';

const canvasContainer = document.getElementById('canvasContainer');
const canvas = document.getElementById('canvas');
const linksLayer = document.getElementById('linksLayer');
const nodesLayer = document.getElementById('nodesLayer');
const inspector = document.getElementById('inspector');
const btnOpenProject = document.getElementById('btnOpenProject');
const btnSettings = document.getElementById('btnSettings');
const btnRefresh = document.getElementById('btnRefresh');
const projectLabel = document.getElementById('projectLabel');
const projectChooser = document.getElementById('projectChooser');
const projectChooserContent = document.getElementById('projectChooserContent');
const storyMetaModal = document.getElementById('storyMetaModal');
const storyMetaContent = document.getElementById('storyMetaContent');
const btnGenerateImages = document.getElementById('btnGenerateImages');

btnSettings.disabled = true;
btnRefresh.disabled = true;
btnGenerateImages.disabled = true;

let panX = -400;
let panY = -300;
let zoom = 1;
let isPanning = false;
let panStart = { x: 0, y: 0 };
let panOrigin = { x: 0, y: 0 };
let didPan = false;
let suppressCanvasClickUntil = 0;

const NODE_WIDTH = 400;
const NODE_HEIGHT = 280;
const NODE_COL_GAP = 60;
const NODE_ROW_GAP = 60;
const NODE_COL_WIDTH = NODE_WIDTH + NODE_COL_GAP;
const NODE_ROW_HEIGHT = NODE_HEIGHT + NODE_ROW_GAP;

// Data for current project
let projectsRootHandle = null; // directory containing story folders (optional)
let currentStoryHandle = null;
let currentStoryName = '';
let nodesDirHandle = null;
let photosDirHandle = null;
let videosDirHandle = null;
let storyMetaHandle = null;
let storyMeta = null;
let chadApiRootDirHandle = null; // root directory for ChadAiApi (will contain Images subfolder)
let nodes = new Map(); // id -> { data, fileHandle }
let selectedNodeId = null;
let nodeParents = new Map();
const saveTimers = new Map();

// --- Canvas transform helpers ---

function updateCanvasTransform() {
    canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

updateCanvasTransform();

canvasContainer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    isPanning = true;
    canvasContainer.classList.add('grabbing');
    panStart = { x: e.clientX, y: e.clientY };
    panOrigin = { x: panX, y: panY };
    didPan = false;
});

window.addEventListener('pointermove', (e) => {
    if (!isPanning) return;
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    if (!didPan && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        didPan = true;
    }
    panX = panOrigin.x + dx;
    panY = panOrigin.y + dy;
    updateCanvasTransform();
});

window.addEventListener('pointerup', () => {
    if (didPan) {
        suppressCanvasClickUntil = Date.now() + 100;
        didPan = false;
    }
    isPanning = false;
    canvasContainer.classList.remove('grabbing');
});

canvasContainer.addEventListener('wheel', (e) => {
    e.preventDefault();

    const rect = canvasContainer.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const oldZoom = zoom;
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    let newZoom = oldZoom * zoomFactor;
    newZoom = Math.min(2.5, Math.max(0.25, newZoom));

    const worldX = (offsetX - centerX - panX) / oldZoom;
    const worldY = (offsetY - centerY - panY) / oldZoom;

    panX = offsetX - centerX - newZoom * worldX;
    panY = offsetY - centerY - newZoom * worldY;

    zoom = newZoom;
    updateCanvasTransform();
}, { passive: false });

// --- Project selection ---

btnOpenProject.addEventListener('click', async () => {
    try {
        await chooseFolderAndOpen();
    } catch (err) {
        if (err && err.name === 'AbortError') {
            // Пользователь нажал "Отмена" в диалоге выбора папки
            return;
        }
        console.error(err);
        alert('Не удалось открыть папку. Браузер должен поддерживать File System Access API (Chrome/Edge) и запуск через http://localhost.');
    }
});

btnSettings.addEventListener('click', () => {
    if (!currentStoryHandle) {
        return;
    }
    openStoryMetaEditor();
});

btnRefresh.addEventListener('click', async () => {
    if (!currentStoryHandle || !nodesDirHandle) {
        return;
    }
    try {
        await reloadNodesFromDisk();
    } catch (err) {
        console.error(err);
        alert('Не удалось обновить ноды из файлов.');
    }
});

btnGenerateImages.addEventListener('click', async () => {
    if (!currentStoryHandle || !nodesDirHandle) {
        alert('Сначала откройте историю.');
        return;
    }
    try {
        await generateOneMissingPhotoWithChad();
    } catch (err) {
        console.error('[ChadAi] unexpected error in button handler', err);
        alert('Ошибка при генерации картинки. Подробности в консоли.');
    }
});

async function chooseFolderAndOpen() {
    const dirHandle = await window.showDirectoryPicker({
        id: 'story-or-project',
        mode: 'readwrite'
    });

    let hasStoryMeta = false;
    let hasNodesDir = false;

    for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind === 'file' && name === 'StoryMeta.json') {
            hasStoryMeta = true;
        } else if (handle.kind === 'directory' && name === 'Nodes') {
            hasNodesDir = true;
        }
    }

    const isProjectsRoot = dirHandle.name.toLowerCase() === 'projects' && !hasStoryMeta && !hasNodesDir;

    if (isProjectsRoot) {
        // Выбрана папка Projects – покажем список историй
        projectsRootHandle = dirHandle;
        await showProjectChooser();
        return;
    }

    // Обычная папка истории (существующая или новая)
    projectsRootHandle = null;

    if (!hasStoryMeta) {
        // Пустая папка или без StoryMeta.json – инициализируем структуру проекта
        await initStoryStructureInExistingFolder(dirHandle);
    } else {
        // Убедимся, что стандартные папки существуют
        await dirHandle.getDirectoryHandle('Nodes', { create: true });
        await dirHandle.getDirectoryHandle('Photos', { create: true });
        await dirHandle.getDirectoryHandle('Videos', { create: true });
    }

    await openStory(dirHandle, dirHandle.name);
}

async function initStoryStructureInExistingFolder(storyDir) {
    const nodesDir = await storyDir.getDirectoryHandle('Nodes', { create: true });
    await storyDir.getDirectoryHandle('Photos', { create: true });
    await storyDir.getDirectoryHandle('Videos', { create: true });

    // StoryMeta.json с одним персонажем @npc
    const meta = {
        characters: [
            {
                id: '@npc',
                name: 'NPC',
                description: ''
            }
        ]
    };
    const metaFile = await storyDir.getFileHandle('StoryMeta.json', { create: true });
    await writeJsonFile(metaFile, meta);

    // Если нод ещё нет – создаём ноду 0
    let hasAnyNode = false;
    for await (const [name, entry] of nodesDir.entries()) {
        if (entry.kind === 'file' && name.toLowerCase().endsWith('.json')) {
            hasAnyNode = true;
            break;
        }
    }
    if (!hasAnyNode) {
        const nodeData = {
            id: 0,
            messages: [],
            answers: []
        };
        const nodeFile = await nodesDir.getFileHandle(padNodeId(0) + '.json', { create: true });
        await writeJsonFile(nodeFile, nodeData);
    }
}

async function showProjectChooser() {
    projectChooserContent.innerHTML = '';

    const title = document.createElement('h3');
    title.textContent = 'Выберите историю';
    projectChooserContent.appendChild(title);

    const list = document.createElement('div');
    projectChooserContent.appendChild(list);

    for await (const [name, handle] of projectsRootHandle.entries()) {
        if (handle.kind !== 'directory') continue;
        const row = document.createElement('div');
        row.className = 'project-list-item';
        const span = document.createElement('span');
        span.className = 'project-name';
        span.textContent = name;
        span.addEventListener('click', async () => {
            projectChooser.classList.add('hidden');
            await openStory(handle, name);
        });
        row.appendChild(span);
        list.appendChild(row);
    }

    const hr = document.createElement('hr');
    projectChooserContent.appendChild(hr);

    const createLabel = document.createElement('div');
    createLabel.textContent = 'Создать новую историю';
    projectChooserContent.appendChild(createLabel);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Имя латиницей без пробелов';
    projectChooserContent.appendChild(nameInput);

    const createBtn = document.createElement('button');
    createBtn.textContent = 'Создать историю';
    createBtn.className = 'small';
    createBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name || /\s/.test(name)) {
            alert('Имя должно быть латиницей без пробелов.');
            return;
        }
        projectChooser.classList.add('hidden');
        await createNewStory(name);
    });
    projectChooserContent.appendChild(createBtn);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Отмена';
    closeBtn.className = 'small';
    closeBtn.style.marginLeft = '8px';
    closeBtn.addEventListener('click', () => {
        projectChooser.classList.add('hidden');
    });
    projectChooserContent.appendChild(closeBtn);

    projectChooser.classList.remove('hidden');
}

async function createNewStory(name) {
    const storyDir = await projectsRootHandle.getDirectoryHandle(name, { create: true });
    const nodesDir = await storyDir.getDirectoryHandle('Nodes', { create: true });
    await storyDir.getDirectoryHandle('Photos', { create: true });
    await storyDir.getDirectoryHandle('Videos', { create: true });

    // StoryMeta.json с одним персонажем @npc
    const meta = {
        characters: [
            {
                id: '@npc',
                name: 'NPC',
                description: ''
            }
        ]
    };
    const metaFile = await storyDir.getFileHandle('StoryMeta.json', { create: true });
    await writeJsonFile(metaFile, meta);

    // Первая нода с id 0
    const nodeData = {
        id: 0,
        messages: [],
        answers: []
    };
    const nodeFile = await nodesDir.getFileHandle(padNodeId(0) + '.json', { create: true });
    await writeJsonFile(nodeFile, nodeData);

    await openStory(storyDir, name);
}

async function openStory(handle, name) {
    currentStoryHandle = handle;
    currentStoryName = name;
    projectLabel.textContent = name;
    btnSettings.disabled = false;
    btnRefresh.disabled = false;
    btnGenerateImages.disabled = false;

    nodes.clear();
    selectedNodeId = null;
    nodesLayer.innerHTML = '';
    linksLayer.innerHTML = '';

    nodesDirHandle = await currentStoryHandle.getDirectoryHandle('Nodes');
    photosDirHandle = await currentStoryHandle.getDirectoryHandle('Photos');
    videosDirHandle = await currentStoryHandle.getDirectoryHandle('Videos');

    storyMetaHandle = await currentStoryHandle.getFileHandle('StoryMeta.json', { create: true });
    let metaFromFile = await readJsonFile(storyMetaHandle);
    if (!metaFromFile || !Array.isArray(metaFromFile.characters)) {
        metaFromFile = {
            characters: [
                {
                    id: '@npc',
                    name: 'NPC',
                    description: ''
                }
            ]
        };
        await writeJsonFile(storyMetaHandle, metaFromFile);
    }
    storyMeta = metaFromFile;

    // Load all nodes
    for await (const [nameEntry, entry] of nodesDirHandle.entries()) {
        if (entry.kind !== 'file' || !nameEntry.toLowerCase().endsWith('.json')) continue;
        const fileData = await readJsonFile(entry);
        if (!fileData || typeof fileData.id !== 'number') continue;
        nodes.set(fileData.id, { data: fileData, fileHandle: entry });
    }

    panX = -400;
    panY = -300;
    zoom = 1;
    updateCanvasTransform();

    layoutAndRenderGraph();
}

async function reloadNodesFromDisk() {
    if (!nodesDirHandle) return;

    const prevSelectedId = selectedNodeId;

    nodes.clear();
    nodesLayer.innerHTML = '';
    linksLayer.innerHTML = '';

    for await (const [nameEntry, entry] of nodesDirHandle.entries()) {
        if (entry.kind !== 'file' || !nameEntry.toLowerCase().endsWith('.json')) continue;
        const fileData = await readJsonFile(entry);
        if (!fileData || typeof fileData.id !== 'number') continue;
        nodes.set(fileData.id, { data: fileData, fileHandle: entry });
    }

    selectedNodeId = prevSelectedId;
    layoutAndRenderGraph();
}

function padNodeId(id) {
    return id.toString().padStart(4, '0');
}

async function readJsonFile(fileHandle) {
    const file = await fileHandle.getFile();
    const text = await file.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        console.error('Failed to parse JSON', fileHandle.name, e);
        return null;
    }
}

async function writeJsonFile(fileHandle, data) {
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 4));
    await writable.close();
}

function scheduleSaveNode(id) {
    if (!nodes.has(id)) return;
    if (saveTimers.has(id)) {
        clearTimeout(saveTimers.get(id));
    }
    const timeoutId = setTimeout(() => {
        saveTimers.delete(id);
        saveNode(id).catch((err) => {
            console.error('Не удалось сохранить ноду', err);
        });
    }, 300);
    saveTimers.set(id, timeoutId);
}

async function saveNode(id) {
    const wrap = nodes.get(id);
    if (!wrap) return;
    await writeJsonFile(wrap.fileHandle, wrap.data);
}

async function copyFileToDir(srcFileHandle, targetDirHandle) {
    const srcFile = await srcFileHandle.getFile();
    const targetHandle = await targetDirHandle.getFileHandle(srcFile.name, { create: true });
    const writable = await targetHandle.createWritable();
    await writable.write(srcFile);
    await writable.close();
    return targetHandle;
}

function getNextNodeId() {
    let maxId = -1;
    for (const id of nodes.keys()) {
        if (id > maxId) maxId = id;
    }
    return maxId + 1;
}

async function loadPhotoPreview(fileName, imgEl) {
    if (!photosDirHandle || !fileName) return;
    try {
        const fileHandle = await photosDirHandle.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        const url = URL.createObjectURL(file);
        imgEl.src = url;
    } catch (err) {
        console.error('Не удалось загрузить превью фото', err);
    }
}

async function ensureChadApiRootHandle() {
    if (chadApiRootDirHandle) {
        return chadApiRootDirHandle;
    }
    try {
        const handle = await window.showDirectoryPicker({
            id: 'chad-ai-api-root',
            mode: 'readwrite'
        });
        if (handle.name !== 'ChadAiApi') {
            console.warn('[ChadAi] Selected directory is not ChadAiApi', { name: handle.name });
            alert(`Пожалуйста, выберите именно папку "ChadAiApi", а не "${handle.name}".`);
            return null;
        }
        chadApiRootDirHandle = handle;
        console.log('[ChadAi] ChadAiApi root directory selected', { name: handle.name });
        return handle;
    } catch (err) {
        if (err && err.name === 'AbortError') {
            console.warn('[ChadAi] Directory selection cancelled by user');
            return null;
        }
        console.error('[ChadAi] Failed to pick ChadAiApi directory', err);
        throw err;
    }
}

async function generateOneMissingPhotoWithChad() {
    if (!currentStoryHandle || !nodesDirHandle || !photosDirHandle) {
        console.warn('[ChadAi] Story or directories are not ready');
        return;
    }

    const chadRoot = await ensureChadApiRootHandle();
    if (!chadRoot) {
        alert('Не выбрана папка ChadAiApi. Повторите попытку и выберите её в диалоге.');
        return;
    }

    console.log('[ChadAi] scanning nodes for photo messages with description and empty photo_file');

    const ids = Array.from(nodes.keys()).sort((a, b) => a - b);
    let processedAny = false;

    for (const id of ids) {
        const wrap = nodes.get(id);
        if (!wrap) continue;
        const node = wrap.data;
        if (!node || !Array.isArray(node.messages)) continue;

        for (let index = 0; index < node.messages.length; index++) {
            const msg = node.messages[index];
            if (!msg || msg.type !== 'photo') continue;
            const hasDescription = typeof msg.photo_description === 'string' && msg.photo_description.trim().length > 0;
            const hasFile = typeof msg.photo_file === 'string' && msg.photo_file.trim().length > 0;
            if (!hasDescription || hasFile) continue;

            console.log('[ChadAi] found candidate', {
                nodeId: node.id,
                messageIndex: index,
                photo_description: msg.photo_description
            });

            processedAny = true;

            try {
                const prompt = msg.photo_description;
                const aspect = '9:16';
                console.log('[ChadAi] calling generateChadImageToImagesDir', {
                    nodeId: node.id,
                    messageIndex: index,
                    prompt,
                    aspect
                });

                const result = await generateChadImageToImagesDir(prompt, aspect, chadRoot, { extension: 'png' });

                console.log('[ChadAi] image generated and saved to ChadAiApi/Images', {
                    nodeId: node.id,
                    messageIndex: index,
                    result
                });

                const copiedHandle = await copyFileToDir(result.fileHandle, photosDirHandle);

                msg.photo_file = copiedHandle.name;
                scheduleSaveNode(node.id);

                console.log('[ChadAi] photo_file assigned and node scheduled for save', {
                    nodeId: node.id,
                    messageIndex: index,
                    photo_file: msg.photo_file
                });

                if (selectedNodeId === node.id) {
                    updateInspector();
                    layoutAndRenderGraph();
                } else {
                    redrawNodeBox(node.id);
                    relayoutLinksFromDom();
                }
            } catch (err) {
                console.error('[ChadAi] error while generating image for node', {
                    nodeId: node.id,
                    messageIndex: index,
                    error: err
                });
            }
        }
    }

    if (!processedAny) {
        console.log('[ChadAi] no suitable messages found (need photo_description and empty photo_file)');
    }
}

function getDefaultSenderId() {
    if (storyMeta && Array.isArray(storyMeta.characters) && storyMeta.characters.length) {
        return storyMeta.characters[0].id;
    }
    return '@npc';
}

function createDefaultMessage() {
    return {
        type: 'text',
        sender: getDefaultSenderId(),
        message: ''
    };
}

function getNextAnswerIdForNode(node) {
    const prefix = `a_${node.id}_`;
    let maxIndex = 0;

    for (const ans of node.answers || []) {
        if (typeof ans.id !== 'string') continue;
        if (!ans.id.startsWith(prefix)) continue;
        const tail = ans.id.slice(prefix.length);
        const num = Number(tail);
        if (Number.isFinite(num) && num > maxIndex) {
            maxIndex = num;
        }
    }

    const nextIndex = maxIndex + 1;
    return `${prefix}${nextIndex}`;
}

function ensureAnswerIds(node) {
    if (!Array.isArray(node.answers) || node.answers.length === 0) return;

    const prefix = `a_${node.id}_`;
    let maxIndex = 0;

    // найдём максимальный уже существующий индекс
    for (const ans of node.answers) {
        if (typeof ans.id !== 'string') continue;
        if (!ans.id.startsWith(prefix)) continue;
        const tail = ans.id.slice(prefix.length);
        const num = Number(tail);
        if (Number.isFinite(num) && num > maxIndex) {
            maxIndex = num;
        }
    }

    let changed = false;
    for (const ans of node.answers) {
        if (typeof ans.id === 'string' && ans.id.startsWith(prefix)) continue;
        maxIndex += 1;
        ans.id = `${prefix}${maxIndex}`;
        changed = true;
    }

    if (changed) {
        scheduleSaveNode(node.id);
    }
}

// --- Graph layout & rendering (very basic for now) ---

function layoutAndRenderGraph() {
    if (nodes.size === 0) {
        inspector.innerHTML = '<p>Нет нод в истории.</p>';
        return;
    }

    const ids = Array.from(nodes.keys()).sort((a, b) => a - b);
    const rootId = ids[0];

    // Simple BFS to compute column per node
    const columnById = new Map();
    const queue = [rootId];
    columnById.set(rootId, 0);

    nodeParents = new Map();

    while (queue.length) {
        const id = queue.shift();
        const col = columnById.get(id) ?? 0;
        const node = nodes.get(id)?.data;
        if (!node) continue;
        for (const ans of node.answers || []) {
            if (!ans.next_node || !nodes.has(ans.next_node)) continue;
            const childId = ans.next_node;
            if (!columnById.has(childId)) {
                columnById.set(childId, col + 1);
                queue.push(childId);
            }
            let parents = nodeParents.get(childId);
            if (!parents) {
                parents = new Set();
                nodeParents.set(childId, parents);
            }
            parents.add(id);
        }
    }

    // Any nodes not reached go to column 0
    for (const id of ids) {
        if (!columnById.has(id)) columnById.set(id, 0);
    }

    const columnToIds = new Map();
    for (const [id, col] of columnById.entries()) {
        if (!columnToIds.has(col)) columnToIds.set(col, []);
        columnToIds.get(col).push(id);
    }
    for (const arr of columnToIds.values()) arr.sort((a, b) => a - b);

    const colWidth = NODE_COL_WIDTH;

    nodesLayer.innerHTML = '';
    linksLayer.innerHTML = '';

    const posById = new Map();

    // Первый проход: создаём DOM-элементы нод с временной вертикальной позицией
    for (const [col, nodeIds] of Array.from(columnToIds.entries()).sort((a, b) => a[0] - b[0])) {
        const x = col * colWidth;
        nodeIds.forEach((id) => {
            const y = 0;
            renderNodeBox(id, nodes.get(id).data, x, y);
        });
    }

    // Второй проход: измеряем фактическую высоту нод и раскладываем их с отступами по колонкам
    for (const [col, nodeIds] of Array.from(columnToIds.entries()).sort((a, b) => a[0] - b[0])) {
        const x = col * colWidth;
        let yCursor = 0;
        nodeIds.forEach((id) => {
            const el = nodesLayer.querySelector(`.node[data-node-id="${id}"]`);
            if (!el) return;
            const height = el.offsetHeight || NODE_HEIGHT;
            el.style.left = x + 'px';
            el.style.top = yCursor + 'px';
            posById.set(id, { x, y: yCursor });
            yCursor += height + NODE_ROW_GAP;
        });
    }

    // Render links from node body to its answers and from answers to next node centers (simplified)
    for (const [id, nodeWrap] of nodes.entries()) {
        const nodeData = nodeWrap.data;
        const fromPos = posById.get(id);
        if (!fromPos) continue;
        const baseX = fromPos.x + NODE_WIDTH - 10; // approx right edge
        const baseY = fromPos.y + 40;
        let offset = 0;
        for (const ans of nodeData.answers || []) {
            const y = baseY + offset;
            offset += 24;
            if (ans.next_node && posById.has(ans.next_node)) {
                const target = posById.get(ans.next_node);
                const targetX = target.x - 10;
                const targetY = target.y + 40;
                addLink(baseX, y, targetX, targetY);
            }
        }
    }

    const idToSelect = selectedNodeId != null && nodes.has(selectedNodeId)
        ? selectedNodeId
        : rootId;

    selectNode(idToSelect);
}

function renderNodeBox(id, nodeData, x, y) {
    const el = document.createElement('div');
    el.className = 'node';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = NODE_WIDTH + 'px';
    el.style.boxSizing = 'border-box';
    el.dataset.nodeId = String(id);
    fillNodeBoxContent(el, nodeData);

    el.addEventListener('click', (e) => {
        if (Date.now() < suppressCanvasClickUntil) {
            e.stopPropagation();
            return;
        }
        e.stopPropagation();
        selectNode(id);
    });

    nodesLayer.appendChild(el);
}

function fillNodeBoxContent(el, nodeData) {
    const existingMsgs = el.querySelector('.node-messages');
    if (existingMsgs) existingMsgs.remove();
    const existingAnswers = el.querySelector('.node-answers');
    if (existingAnswers) existingAnswers.remove();

    const msgContainer = document.createElement('div');
    msgContainer.className = 'node-messages';
    if (Array.isArray(nodeData.messages) && nodeData.messages.length) {
        for (const msg of nodeData.messages) {
            const block = document.createElement('div');
            block.className = 'node-message-block';

            if (msg.type === 'text' || msg.type === 'system') {
                const p = document.createElement('div');
                p.className = 'node-message-text';
                p.textContent = msg.message || '';
                block.appendChild(p);
            } else if (msg.type === 'photo') {
                if (msg.photo_file) {
                    const img = document.createElement('img');
                    img.className = 'node-message-photo-thumb';
                    img.alt = msg.photo_message || '';
                    loadPhotoPreview(msg.photo_file, img);
                    block.appendChild(img);
                }
                if (msg.photo_message) {
                    const caption = document.createElement('div');
                    caption.className = 'node-message-text';
                    caption.textContent = msg.photo_message;
                    block.appendChild(caption);
                }
            } else if (msg.type === 'video') {
                const p = document.createElement('div');
                p.className = 'node-message-text';
                const label = '[Видео] ';
                p.textContent = label + (msg.video_message || '');
                block.appendChild(p);
            } else {
                const p = document.createElement('div');
                p.className = 'node-message-text';
                p.textContent = '(неизвестный тип сообщения)';
                block.appendChild(p);
            }

            msgContainer.appendChild(block);
        }
    } else {
        msgContainer.textContent = '(нет сообщений)';
    }
    el.appendChild(msgContainer);

    const answersContainer = document.createElement('div');
    answersContainer.className = 'node-answers';
    if (Array.isArray(nodeData.answers) && nodeData.answers.length) {
        for (const ans of nodeData.answers) {
            const aEl = document.createElement('div');
            aEl.className = 'node-answer';
            aEl.textContent = ans.message || '(пустой ответ)';
            answersContainer.appendChild(aEl);
        }
    } else {
        const empty = document.createElement('div');
        empty.className = 'node-answer';
        empty.style.opacity = '0.6';
        empty.textContent = '(нет ответов)';
        answersContainer.appendChild(empty);
    }
    el.appendChild(answersContainer);
}

function redrawNodeBox(id) {
    const wrap = nodes.get(id);
    if (!wrap) return;
    const el = nodesLayer.querySelector(`.node[data-node-id="${id}"]`);
    if (!el) return;
    fillNodeBoxContent(el, wrap.data);
}

function addLink(x1, y1, x2, y2) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const midX = (x1 + x2) / 2;
    const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
    path.setAttribute('d', d);
    path.setAttribute('stroke', '#ffffff');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    linksLayer.appendChild(path);
}

function relayoutLinksFromDom() {
    linksLayer.innerHTML = '';

    const posById = new Map();
    for (const el of nodesLayer.querySelectorAll('.node')) {
        const id = Number(el.dataset.nodeId);
        if (!Number.isFinite(id)) continue;
        const x = parseFloat(el.style.left) || 0;
        const y = parseFloat(el.style.top) || 0;
        posById.set(id, { x, y });
    }

    for (const [id, nodeWrap] of nodes.entries()) {
        const nodeData = nodeWrap.data;
        const fromPos = posById.get(id);
        if (!fromPos) continue;
        const baseX = fromPos.x + NODE_WIDTH - 10;
        const baseY = fromPos.y + 40;
        let offset = 0;
        for (const ans of nodeData.answers || []) {
            const y = baseY + offset;
            offset += 24;
            if (ans.next_node && posById.has(ans.next_node)) {
                const target = posById.get(ans.next_node);
                const targetX = target.x - 10;
                const targetY = target.y + 40;
                addLink(baseX, y, targetX, targetY);
            }
        }
    }
}

function selectNode(id) {
    selectedNodeId = id;

    const pathBeforeIds = new Set();

    if (id != null && nodes.has(id)) {
        const visited = new Set();
        const queue = [id];
        visited.add(id);

        while (queue.length) {
            const currentId = queue.shift();
            const parents = nodeParents.get(currentId);
            if (!parents) continue;
            for (const parentId of parents) {
                if (visited.has(parentId)) continue;
                visited.add(parentId);
                pathBeforeIds.add(parentId);
                queue.push(parentId);
            }
        }
    } else {
        selectedNodeId = null;
    }

    const pathAfterIds = new Set();

    if (selectedNodeId != null) {
        for (const [childId, parents] of nodeParents.entries()) {
            if (parents && parents.has(selectedNodeId)) {
                pathAfterIds.add(childId);
            }
        }
    }

    // Vertically align highlighted nodes (ancestors + selected) across columns
    if (selectedNodeId != null && nodes.has(selectedNodeId)) {
        const nodesByCol = new Map(); // col -> [{ el, id, y }]
        let selectedY = null;

        for (const el of nodesLayer.querySelectorAll('.node')) {
            const nodeId = Number(el.dataset.nodeId);
            const x = parseFloat(el.style.left) || 0;
            const y = parseFloat(el.style.top) || 0;
            const col = Math.round(x / NODE_COL_WIDTH);

            if (!nodesByCol.has(col)) {
                nodesByCol.set(col, []);
            }
            nodesByCol.get(col).push({ el, id: nodeId, y });

            if (nodeId === selectedNodeId) {
                selectedY = y;
            }
        }

        if (selectedY != null) {
            for (const [col, items] of nodesByCol.entries()) {
                const highlighted = items.filter(item => item.id === selectedNodeId || pathBeforeIds.has(item.id));
                if (!highlighted.length) continue;

                const sumY = highlighted.reduce((sum, item) => sum + item.y, 0);
                const meanY = sumY / highlighted.length;
                const delta = selectedY - meanY;

                if (Math.abs(delta) < 0.5) continue;

                for (const item of items) {
                    const newY = item.y + delta;
                    item.el.style.top = newY + 'px';
                }
            }

            relayoutLinksFromDom();
        }
    }

    for (const el of nodesLayer.querySelectorAll('.node')) {
        const nodeId = Number(el.dataset.nodeId);
        el.classList.remove('selected', 'path-before', 'path-after');
        if (selectedNodeId != null && nodeId === selectedNodeId) {
            el.classList.add('selected');
        } else if (pathBeforeIds.has(nodeId)) {
            el.classList.add('path-before');
        } else if (pathAfterIds.has(nodeId)) {
            el.classList.add('path-after');
        }
    }

    updateInspector();
}

function updateInspector() {
    if (selectedNodeId == null || !nodes.has(selectedNodeId)) {
        inspector.innerHTML = '<p>Выберите ноду.</p>';
        return;
    }
    const nodeWrap = nodes.get(selectedNodeId);
    const node = nodeWrap.data;

    if (!Array.isArray(node.messages)) node.messages = [];
    if (!Array.isArray(node.answers)) node.answers = [];
    ensureAnswerIds(node);

    const container = document.createElement('div');

    const title = document.createElement('div');
    title.className = 'inspector-section-title';
    title.textContent = `Нода ${node.id}`;
    container.appendChild(title);

    // Сообщения
    const messagesSection = document.createElement('div');
    messagesSection.className = 'inspector-section';
    const msgTitle = document.createElement('div');
    msgTitle.className = 'inspector-section-title';
    msgTitle.textContent = 'Сообщения';
    messagesSection.appendChild(msgTitle);

    const messagesList = document.createElement('div');
    messagesSection.appendChild(messagesList);

    node.messages.forEach((msg, index) => {
        const block = createMessageBlock(node, msg, index);
        messagesList.appendChild(block);
    });

    const addMsgBtn = document.createElement('button');
    addMsgBtn.textContent = 'Добавить сообщение';
    addMsgBtn.className = 'small';
    addMsgBtn.addEventListener('click', () => {
        node.messages.push(createDefaultMessage());
        scheduleSaveNode(node.id);
        updateInspector();
        layoutAndRenderGraph();
    });
    messagesSection.appendChild(addMsgBtn);

    container.appendChild(messagesSection);

    // Ответы
    const answersSection = document.createElement('div');
    answersSection.className = 'inspector-section';
    const ansTitle = document.createElement('div');
    ansTitle.className = 'inspector-section-title';
    ansTitle.textContent = 'Ответы';
    answersSection.appendChild(ansTitle);

    const answersList = document.createElement('div');
    answersSection.appendChild(answersList);

    node.answers.forEach((ans, index) => {
        const block = createAnswerBlock(node, ans, index);
        answersList.appendChild(block);
    });

    const addAnsBtn = document.createElement('button');
    addAnsBtn.textContent = 'Добавить ответ';
    addAnsBtn.className = 'small';
    addAnsBtn.addEventListener('click', () => {
        node.answers.push({
            id: getNextAnswerIdForNode(node),
            message: '',
            delay: 0,
            next_node: null
        });
        scheduleSaveNode(node.id);
        updateInspector();
        layoutAndRenderGraph();
    });
    answersSection.appendChild(addAnsBtn);

    container.appendChild(answersSection);

    inspector.innerHTML = '';
    inspector.appendChild(container);
}

// Click on empty canvas clears selection
canvasContainer.addEventListener('click', (e) => {
    if (Date.now() < suppressCanvasClickUntil) {
        return;
    }
    if (e.target.closest && e.target.closest('.node')) {
        return;
    }
    selectNode(null);
});

function createMessageBlock(node, msg, index) {
    const block = document.createElement('div');
    block.className = 'message-block';

    const header = document.createElement('div');
    header.className = 'message-header';

    const label = document.createElement('span');
    label.textContent = `Сообщение ${index + 1}`;
    header.appendChild(label);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '-';
    removeBtn.className = 'small danger';
    removeBtn.addEventListener('click', () => {
        node.messages.splice(index, 1);
        scheduleSaveNode(node.id);
        updateInspector();
        layoutAndRenderGraph();
    });
    header.appendChild(removeBtn);

    block.appendChild(header);

    const senderLabel = document.createElement('label');
    senderLabel.className = 'field-label';
    senderLabel.textContent = 'Отправитель';
    block.appendChild(senderLabel);

    const senderSelect = document.createElement('select');
    const characters = storyMeta && Array.isArray(storyMeta.characters) ? storyMeta.characters : [];
    if (characters.length === 0) {
        const opt = document.createElement('option');
        opt.value = msg.sender || '';
        opt.textContent = msg.sender || '(нет персонажей)';
        senderSelect.appendChild(opt);
    } else {
        for (const ch of characters) {
            const opt = document.createElement('option');
            opt.value = ch.id;
            opt.textContent = ch.id;
            senderSelect.appendChild(opt);
        }
    }
    senderSelect.value = msg.sender || getDefaultSenderId();
    senderSelect.addEventListener('change', () => {
        msg.sender = senderSelect.value;
        scheduleSaveNode(node.id);
    });
    block.appendChild(senderSelect);

    const typeLabel = document.createElement('label');
    typeLabel.className = 'field-label';
    typeLabel.textContent = 'Тип';
    block.appendChild(typeLabel);

    const typeSelect = document.createElement('select');
    const types = [
        { value: 'text', label: 'текст' },
        { value: 'photo', label: 'фото + текст' },
        { value: 'video', label: 'видео + текст' },
        { value: 'system', label: 'системное' }
    ];
    for (const t of types) {
        const opt = document.createElement('option');
        opt.value = t.value;
        opt.textContent = t.label;
        typeSelect.appendChild(opt);
    }
    typeSelect.value = msg.type || 'text';
    typeSelect.addEventListener('change', () => {
        msg.type = typeSelect.value;
        scheduleSaveNode(node.id);
        updateInspector();
        layoutAndRenderGraph();
    });
    block.appendChild(typeSelect);

    if (msg.type === 'text' || msg.type === 'system') {
        const textLabel = document.createElement('label');
        textLabel.className = 'field-label';
        textLabel.textContent = 'Текст';
        block.appendChild(textLabel);

        const textarea = document.createElement('textarea');
        textarea.value = msg.message || '';
        textarea.addEventListener('input', () => {
            msg.message = textarea.value;
            scheduleSaveNode(node.id);
            redrawNodeBox(node.id);
        });
        block.appendChild(textarea);
    } else if (msg.type === 'photo') {
        const descLabel = document.createElement('label');
        descLabel.className = 'field-label';
        descLabel.textContent = 'Описание фото';
        block.appendChild(descLabel);

        const descArea = document.createElement('textarea');
        descArea.value = msg.photo_description || '';
        descArea.addEventListener('input', () => {
            msg.photo_description = descArea.value;
            scheduleSaveNode(node.id);
        });
        block.appendChild(descArea);

        const previewLabel = document.createElement('label');
        previewLabel.className = 'field-label';
        previewLabel.textContent = 'Фото';
        block.appendChild(previewLabel);

        const previewWrapper = document.createElement('div');
        previewWrapper.style.border = '1px solid #555';
        previewWrapper.style.borderRadius = '3px';
        previewWrapper.style.height = '120px';
        previewWrapper.style.display = 'flex';
        previewWrapper.style.alignItems = 'center';
        previewWrapper.style.justifyContent = 'center';
        previewWrapper.style.overflow = 'hidden';
        previewWrapper.style.background = '#111';

        const img = document.createElement('img');
        img.style.maxWidth = '100%';
        img.style.maxHeight = '100%';
        if (msg.photo_file) {
            loadPhotoPreview(msg.photo_file, img);
        } else {
            img.alt = 'Нет файла';
        }
        previewWrapper.appendChild(img);
        block.appendChild(previewWrapper);

        const fileName = document.createElement('div');
        fileName.style.fontSize = '11px';
        fileName.style.opacity = '0.8';
        fileName.textContent = msg.photo_file || '(файл не выбран)';
        block.appendChild(fileName);

        const buttonsRow = document.createElement('div');
        buttonsRow.style.display = 'flex';
        buttonsRow.style.gap = '4px';

        const chooseBtn = document.createElement('button');
        chooseBtn.textContent = 'Выбрать фото';
        chooseBtn.className = 'small';
        chooseBtn.addEventListener('click', async () => {
            if (!photosDirHandle) {
                alert('Папка Photos не найдена.');
                return;
            }
            try {
                const [fileHandle] = await window.showOpenFilePicker({
                    multiple: false,
                    types: [
                        {
                            description: 'Изображения',
                            accept: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif'] }
                        }
                    ]
                });
                if (!fileHandle) return;
                const targetHandle = await copyFileToDir(fileHandle, photosDirHandle);
                msg.photo_file = targetHandle.name;
                scheduleSaveNode(node.id);
                updateInspector();
                layoutAndRenderGraph();
            } catch (err) {
                if (err && err.name === 'AbortError') return;
                console.error(err);
                alert('Не удалось выбрать фото.');
            }
        });
        buttonsRow.appendChild(chooseBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '-';
        deleteBtn.className = 'small danger';
        deleteBtn.addEventListener('click', async () => {
            if (!msg.photo_file) {
                return;
            }
            if (!photosDirHandle) {
                alert('Папка Photos не найдена.');
                return;
            }
            try {
                await photosDirHandle.removeEntry(msg.photo_file);
            } catch (err) {
                console.error('Не удалось удалить файл фото', err);
            }
            msg.photo_file = '';
            scheduleSaveNode(node.id);
            updateInspector();
            layoutAndRenderGraph();
        });
        buttonsRow.appendChild(deleteBtn);

        block.appendChild(buttonsRow);

        const textLabel2 = document.createElement('label');
        textLabel2.className = 'field-label';
        textLabel2.textContent = 'Текст к фото';
        block.appendChild(textLabel2);

        const textArea2 = document.createElement('textarea');
        textArea2.value = msg.photo_message || '';
        textArea2.addEventListener('input', () => {
            msg.photo_message = textArea2.value;
            scheduleSaveNode(node.id);
            redrawNodeBox(node.id);
        });
        block.appendChild(textArea2);
    } else if (msg.type === 'video') {
        const descLabel = document.createElement('label');
        descLabel.className = 'field-label';
        descLabel.textContent = 'Описание видео';
        block.appendChild(descLabel);

        const descArea = document.createElement('textarea');
        descArea.value = msg.video_description || '';
        descArea.addEventListener('input', () => {
            msg.video_description = descArea.value;
            scheduleSaveNode(node.id);
        });
        block.appendChild(descArea);

        const fileNameLabel = document.createElement('label');
        fileNameLabel.className = 'field-label';
        fileNameLabel.textContent = 'Видео-файл';
        block.appendChild(fileNameLabel);

        const fileNameDiv = document.createElement('div');
        fileNameDiv.style.fontSize = '11px';
        fileNameDiv.style.opacity = '0.8';
        fileNameDiv.textContent = msg.video_file || '(файл не выбран)';
        block.appendChild(fileNameDiv);

        const chooseVideoBtn = document.createElement('button');
        chooseVideoBtn.textContent = 'Выбрать видео';
        chooseVideoBtn.className = 'small';
        chooseVideoBtn.addEventListener('click', async () => {
            if (!videosDirHandle) {
                alert('Папка Videos не найдена.');
                return;
            }
            try {
                const [fileHandle] = await window.showOpenFilePicker({
                    multiple: false,
                    types: [
                        {
                            description: 'Видео',
                            accept: { 'video/*': ['.mp4', '.webm', '.mov'] }
                        }
                    ]
                });
                if (!fileHandle) return;
                const targetHandle = await copyFileToDir(fileHandle, videosDirHandle);
                msg.video_file = targetHandle.name;
                scheduleSaveNode(node.id);
                updateInspector();
                layoutAndRenderGraph();
            } catch (err) {
                if (err && err.name === 'AbortError') return;
                console.error(err);
                alert('Не удалось выбрать видео.');
            }
        });
        block.appendChild(chooseVideoBtn);

        const subsLabel = document.createElement('label');
        subsLabel.className = 'field-label';
        subsLabel.textContent = 'Субтитры (реплики)';
        block.appendChild(subsLabel);

        const subsArea = document.createElement('textarea');
        subsArea.value = msg.video_subtitles || '';
        subsArea.addEventListener('input', () => {
            msg.video_subtitles = subsArea.value;
            scheduleSaveNode(node.id);
        });
        block.appendChild(subsArea);

        const textLabel = document.createElement('label');
        textLabel.className = 'field-label';
        textLabel.textContent = 'Текст к видео';
        block.appendChild(textLabel);

        const textArea = document.createElement('textarea');
        textArea.value = msg.video_message || '';
        textArea.addEventListener('input', () => {
            msg.video_message = textArea.value;
            scheduleSaveNode(node.id);
            redrawNodeBox(node.id);
        });
        block.appendChild(textArea);
    }

    return block;
}

function createAnswerBlock(node, ans, index) {
    const block = document.createElement('div');
    block.className = 'answer-block';

    const header = document.createElement('div');
    header.className = 'answer-header';

    const label = document.createElement('span');
    label.textContent = `Ответ ${index + 1}`;
    header.appendChild(label);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '-';
    removeBtn.className = 'small danger';
    removeBtn.addEventListener('click', () => {
        node.answers.splice(index, 1);
        scheduleSaveNode(node.id);
        updateInspector();
        layoutAndRenderGraph();
    });
    header.appendChild(removeBtn);

    block.appendChild(header);

    const msgLabel = document.createElement('label');
    msgLabel.className = 'field-label';
    msgLabel.textContent = 'Текст ответа';
    block.appendChild(msgLabel);

    const msgInput = document.createElement('textarea');
    msgInput.value = ans.message || '';
    msgInput.addEventListener('input', () => {
        ans.message = msgInput.value;
        scheduleSaveNode(node.id);
        redrawNodeBox(node.id);
    });
    block.appendChild(msgInput);

    const delayLabel = document.createElement('label');
    delayLabel.className = 'field-label';
    delayLabel.textContent = 'Задержка (сек)';
    block.appendChild(delayLabel);

    const delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.min = '0';
    delayInput.value = ans.delay != null ? String(ans.delay) : '0';
    delayInput.addEventListener('input', () => {
        const v = Number(delayInput.value);
        ans.delay = Number.isFinite(v) ? v : 0;
        scheduleSaveNode(node.id);
    });
    block.appendChild(delayInput);

    const nextLabel = document.createElement('label');
    nextLabel.className = 'field-label';
    nextLabel.textContent = 'Следующая нода (id)';
    block.appendChild(nextLabel);

    const nextRow = document.createElement('div');
    nextRow.style.display = 'flex';
    nextRow.style.gap = '4px';
    block.appendChild(nextRow);

    const nextInput = document.createElement('input');
    nextInput.type = 'number';
    nextInput.style.flex = '1';
    nextInput.value = ans.next_node != null ? String(ans.next_node) : '';
    nextInput.addEventListener('input', () => {
        const v = nextInput.value === '' ? null : Number(nextInput.value);
        ans.next_node = v;
        scheduleSaveNode(node.id);
        layoutAndRenderGraph();
    });
    nextRow.appendChild(nextInput);

    const createBtn = document.createElement('button');
    createBtn.textContent = 'Создать ноду';
    createBtn.className = 'small';
    createBtn.addEventListener('click', async () => {
        try {
            const newId = getNextNodeId();
            const newNodeData = {
                id: newId,
                messages: [],
                answers: []
            };
            const nodeFile = await nodesDirHandle.getFileHandle(padNodeId(newId) + '.json', { create: true });
            await writeJsonFile(nodeFile, newNodeData);
            nodes.set(newId, { data: newNodeData, fileHandle: nodeFile });
            ans.next_node = newId;
            scheduleSaveNode(node.id);
            layoutAndRenderGraph();
            selectNode(newId);
        } catch (err) {
            console.error(err);
            alert('Не удалось создать ноду.');
        }
    });
    nextRow.appendChild(createBtn);

    return block;
}

function openStoryMetaEditor() {
    if (!storyMeta) return;

    storyMetaContent.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'inspector-section-title';
    title.textContent = 'StoryMeta (персонажи)';
    storyMetaContent.appendChild(title);

    const info = document.createElement('p');
    info.textContent = 'Редактор StoryMeta будет реализован позже.';
    storyMetaContent.appendChild(info);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Закрыть';
    closeBtn.className = 'small';
    closeBtn.addEventListener('click', () => {
        storyMetaModal.classList.add('hidden');
    });
    storyMetaContent.appendChild(closeBtn);

    storyMetaModal.classList.remove('hidden');
}
