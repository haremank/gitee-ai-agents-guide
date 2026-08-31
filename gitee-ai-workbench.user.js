// ==UserScript==
// @name         Gitee AI - 多模型生成工作台
// @namespace    https://ai.gitee.com/
// @version      2.9.3
// @description  在任意网站提供可拖拽的多模型生成入口，按文生图、文生视频、图生视频、语音合成、图片转 3D、文本对话（免费 Qwen3/GLM4/DeepSeek-R1 全家桶）和语音识别（免费 GLM-ASR/SenseVoice）显示不同参数面板；分辨率和能力按官方模型元数据动态适配。自动获取访问令牌，支持一键导出 Agent 提示词（供 Codex / Claude Code 等直接调用接口），支持异步任务轮询、全参数控制台、结果预览、下载与 IndexedDB 本地生成库。
// @author       Antigravity
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      ai.gitee.com
// @connect      gitee-ai.su.bcebos.com
// @connect      raw.githubusercontent.com
// @resource GITEE_CONTROLS https://raw.githubusercontent.com/haremank/gitee-ai-agents-guide/main/assets/gitee-serverless-controls.compact.json
// @run-at       document-idle
// @noframes
// @include      file:///*
// ==/UserScript==

(function () {
    'use strict';

    // 0. 安全封装 GM API，兼容无 GM 环境（如直接注入、控制台执行、非标准扩展）
    const safeGM = {
        getValuePrivate: (key, defVal) => {
            try {
                if (typeof GM_getValue !== 'undefined') return GM_getValue(key, defVal);
            } catch (e) {}
            return defVal;
        },
        getValue: (key, defVal) => {
            try {
                if (typeof GM_getValue !== 'undefined') return GM_getValue(key, defVal);
            } catch (e) {}
            try {
                return localStorage.getItem(key) || defVal;
            } catch (e) {
                // 某些站点在隐私模式 / 沙箱下 localStorage 访问会直接抛错
                return defVal;
            }
        },
        setValue: (key, val) => {
            try {
                if (typeof GM_setValue !== 'undefined') GM_setValue(key, val);
            } catch (e) {}
            try {
                localStorage.setItem(key, val);
            } catch (e) {}
        },
        setValuePrivate: (key, val) => {
            let saved = false;
            try {
                if (typeof GM_setValue !== 'undefined') {
                    GM_setValue(key, val);
                    saved = true;
                }
            } catch (e) {}
            try {
                localStorage.removeItem(key);
            } catch (e) {}
            return saved;
        },
        xmlhttpRequest: (opts) => {
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                return GM_xmlhttpRequest(opts);
            }
            const controller = new AbortController();
            const timeoutId = opts.timeout ? setTimeout(() => controller.abort(), opts.timeout) : null;

            fetch(opts.url, {
                method: opts.method || 'GET',
                headers: opts.headers || {},
                body: opts.data,
                signal: controller.signal
            }).then(async (res) => {
                if (timeoutId) clearTimeout(timeoutId);
                let text = '';
                // 无 GM 环境下用 ReadableStream 模拟 onprogress，让流式输出同样可用
                if (opts.onprogress && res.body && typeof res.body.getReader === 'function') {
                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        text += decoder.decode(value, { stream: true });
                        try { opts.onprogress({ responseText: text }); } catch (e) {}
                    }
                    text += decoder.decode();
                } else {
                    text = await res.text();
                }
                const headersObj = {};
                for (const [k, v] of res.headers.entries()) {
                    headersObj[k.toLowerCase()] = v;
                }
                if (opts.onload) {
                    opts.onload({
                        status: res.status,
                        statusText: res.statusText,
                        responseText: text,
                        responseHeaders: res.headers,
                        getResponseHeader: (h) => headersObj[h.toLowerCase()] || null
                    });
                }
            }).catch((err) => {
                if (timeoutId) clearTimeout(timeoutId);
                if (err.name === 'AbortError') {
                    if (opts.ontimeout) opts.ontimeout();
                } else {
                    if (opts.onerror) opts.onerror(err);
                }
            });
        }
    };

    // 卸载已存在的实例（防止重复注入）
    if (window.__Z_IMAGE_DESTROY__) {
        window.__Z_IMAGE_DESTROY__();
    }

    const STORAGE_TOKEN_KEY = 'gitee_ai_custom_token';
    const STORAGE_HISTORY_KEY = 'gitee_ai_zimage_history';
    const STORAGE_DISMISSED_CLOUD_TASKS_KEY = 'gitee_ai_dismissed_cloud_tasks';
    const LIBRARY_DB_NAME = 'gitee-ai-workbench-library';
    const LIBRARY_DB_VERSION = 1;
    const LIBRARY_STORE = 'items';
    const SETTINGS_DB_NAME = 'gitee-ai-workbench-settings';
    const SETTINGS_DB_VERSION = 1;
    const SETTINGS_STORE = 'handles';
    const SETTINGS_DIRECTORY_KEY = 'downloadDirectory';
    const STORAGE_FAB_POS = 'gitee_ai_zimage_fab_pos';
    const STORAGE_QUOTA_KEY = 'gitee_ai_zimage_live_quota';
    const API_BASE = "https://ai.gitee.com";
    const ENDPOINTS = {
        image: "/v1/images/generations",
        textVideo: "/v1/async/videos/generations",
        imageVideo: "/v1/async/videos/image-to-video",
        speech: "/v1/async/audio/speech",
        threeD: "/v1/async/image-to-3d",
        chat: "/v1/chat/completions",
        asr: "/v1/audio/transcriptions",
        task: "/v1/task/",
        tasks: "/v1/tasks",
        taskQuota: "/v1/tasks/available-quota"
    };

    const MODEL_REGISTRY = {
        image: {
            label: "文生图",
            models: [
                { value: "z-image-turbo", name: "Z-Image Turbo", verified: true, steps: [4, 20, 9] },
                { value: "flux-1-schnell", name: "FLUX.1 Schnell", verified: true, steps: [1, 12, 4] },
                { value: "CogView4_6B", name: "CogView4 6B", steps: [1, 50, 20] },
                { value: "FLUX_1-Krea-dev", name: "FLUX.1 Krea Dev", steps: [1, 50, 20] },
                { value: "FLUX.1-dev", name: "FLUX.1 Dev", steps: [1, 50, 24] },
                { value: "FLUX.2-dev", name: "FLUX.2 Dev", steps: [1, 50, 24] },
                { value: "FLUX.2-klein-4B", name: "FLUX.2 Klein 4B", steps: [1, 16, 4] },
                { value: "FLUX.2-klein-9B", name: "FLUX.2 Klein 9B", steps: [1, 24, 8] },
                { value: "GLM-Image", name: "GLM Image", steps: [1, 50, 20] },
                { value: "HiDream-I1-Full", name: "HiDream I1 Full", steps: [1, 50, 24] },
                { value: "Kolors", name: "Kolors", steps: [1, 50, 25] },
                { value: "LongCat-Image", name: "LongCat Image", steps: [1, 50, 20] },
                { value: "Qwen-Image", name: "Qwen Image", steps: [1, 50, 20] },
                { value: "Qwen-Image-2512", name: "Qwen Image 2512", steps: [1, 50, 20] },
                { value: "stable-diffusion-3-medium", name: "Stable Diffusion 3 Medium", steps: [1, 50, 28] },
                { value: "stable-diffusion-3.5-large-turbo", name: "SD 3.5 Large Turbo", steps: [1, 12, 4] },
                { value: "stable-diffusion-xl-base-1.0", name: "SDXL Base 1.0", steps: [1, 50, 30] },
                { value: "Z-Image", name: "Z-Image", steps: [1, 40, 12] }
            ]
        },
        textVideo: {
            label: "文生视频",
            models: [
                { value: "HunyuanVideo-1.5", name: "HunyuanVideo 1.5", verified: true, steps: [1, 10, 4], frames: [81, 106, 131, 161, 191, 241], fps: [16, 24], aspect: true },
                { value: "Wan2.1-T2V-14B", name: "Wan2.1 T2V 14B", verified: true, steps: [1, 80, 50], frames: [25, 50, 75, 100] }
            ]
        },
        imageVideo: {
            label: "图生视频",
            models: [
                { value: "LTX-2", name: "LTX-2", steps: [1, 40, 8], frames: [25, 33, 49, 73, 121, 241], fps: [16, 24] },
                { value: "Wan2_2-I2V-A14B", name: "Wan2.2 I2V A14B", steps: [1, 30, 10], frames: [25, 33, 50], guidance: true }
            ]
        },
        speech: {
            label: "语音合成",
            models: [
                { value: "Spark-TTS-0.5B", name: "Spark TTS 0.5B", verified: true }
            ]
        },
        threeD: {
            label: "图片转 3D",
            models: [
                { value: "Hunyuan3D-2", name: "Hunyuan3D 2", steps: [2, 50, 5], octree: [16, 64, 128, 256, 400], guidance: true, texture: true, advanced: true },
                { value: "Hi3DGen", name: "Hi3DGen", format: ["glb", "stl"] }
            ]
        },
        chat: {
            label: "文本对话",
            free: true,
            models: [
                { value: "Qwen3-8B", name: "Qwen3 8B" },
                { value: "Qwen3-4B", name: "Qwen3 4B" },
                { value: "Qwen3-0.6B", name: "Qwen3 0.6B" },
                { value: "DeepSeek-R1-Distill-Qwen-14B", name: "DeepSeek R1 蒸馏 14B（推理）" },
                { value: "DeepSeek-R1-Distill-Qwen-7B", name: "DeepSeek R1 蒸馏 7B（推理）" },
                { value: "DeepSeek-R1-Distill-Qwen-1.5B", name: "DeepSeek R1 蒸馏 1.5B（推理）" },
                { value: "glm-4-9b-chat", name: "GLM4 9B Chat" },
                { value: "GLM-4-9B-0414", name: "GLM4 9B 0414" },
                { value: "Qwen2-7B-Instruct", name: "Qwen2 7B Instruct" },
                { value: "internlm3-8b-instruct", name: "书生·浦语3 8B" },
                { value: "DeepSeek-Prover-V2-7B", name: "DeepSeek Prover V2 7B（数学证明）" },
                { value: "HuatuoGPT-o1-7B", name: "华佗 GPT o1 7B（医疗）" },
                { value: "Lingshu-32B", name: "灵枢 32B（医疗）" },
                { value: "HealthGPT-L14", name: "HealthGPT L14（医疗）" }
            ]
        },
        asr: {
            label: "语音识别",
            free: true,
            models: [
                { value: "GLM-ASR", name: "GLM ASR（超轻量中文）" },
                { value: "SenseVoiceSmall", name: "SenseVoice Small（多语种）" }
            ]
        }
    };

    const QUICK_IMAGE_SIZES = ['256x256', '512x512', '1024x1024', '1024x768', '768x1024', '1024x576', '576x1024', '1024x640', '640x1024'];

    // 排除已知文档示例假 Token 及第三方埋点/客服 Key；样例分片拼接，避免密钥扫描误报。
    const DUMMY_TOKENS = [
        ['RMFBN', 'NRRAXU', '9U5NCXNDV', '7VIZGTMNSXYU', '7911ICS'].join(''),
        'YOUR_API_TOKEN',
        'YOUR_ACCESS_TOKEN',
        'YOUR_API_KEY',
        'YOUR_TOKEN'
    ];
    // 是否运行在 Gitee 站点：React 树 / localStorage / 额度 DOM 等页面级探测只在自己站点上做，
    // 其它网站上仅使用 GM 存储的令牌（跨站共享），避免误读第三方站点数据或误填无关令牌
    const IS_GITEE_HOST = /(^|\.)gitee\.com$/.test(location.hostname);

    let isGenerating = false;
    let generateTimer = null;
    let generateStartTime = 0;
    let historyList = [];
    let libraryDb = null;
    let libraryReady = null;
    let libraryInitPromise = null;
    let libraryList = [];
    let libraryFilter = 'all';
    let libraryQuery = '';
    let libraryObjectUrls = [];
    let settingsDbReady = null;
    let downloadDirectoryHandle = null;
    let downloadDirectoryNeedsPermission = false;
    let cloudTasks = [];
    let cloudTaskTotal = 0;
    let cloudTaskQuota = null;
    let importingCloudTasks = false;
    let cloudTaskExpired = new Set();
    let cloudTaskDismissed = new Set();
    const CLOUD_TASK_LINK_TTL = 24 * 60 * 60 * 1000;
    try {
        const savedDismissed = safeGM.getValue(STORAGE_DISMISSED_CLOUD_TASKS_KEY, '[]');
        const parsed = JSON.parse(savedDismissed || '[]');
        if (Array.isArray(parsed)) cloudTaskDismissed = new Set(parsed.filter(Boolean).map(String));
    } catch (_) {}
    try {
        const savedHist = safeGM.getValue(STORAGE_HISTORY_KEY, '') || localStorage.getItem(STORAGE_HISTORY_KEY);
        if (savedHist) historyList = JSON.parse(savedHist);
    } catch(e) {}

    function openLibrary() {
        if (libraryReady) return libraryReady;
        libraryReady = new Promise((resolve) => {
            if (typeof indexedDB === 'undefined' || !indexedDB) {
                resolve(null);
                return;
            }
            const request = indexedDB.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(LIBRARY_STORE)) {
                    const store = db.createObjectStore(LIBRARY_STORE, { keyPath: 'id' });
                    store.createIndex('createdAt', 'createdAt');
                }
            };
            request.onsuccess = () => {
                libraryDb = request.result;
                resolve(libraryDb);
            };
            request.onerror = () => resolve(null);
        });
        return libraryReady;
    }

    function withLibrary(mode, callback) {
        return openLibrary().then(db => new Promise((resolve, reject) => {
            if (!db) {
                reject(new Error('indexeddb-unavailable'));
                return;
            }
            const tx = db.transaction(LIBRARY_STORE, mode);
            const store = tx.objectStore(LIBRARY_STORE);
            const request = callback(store);
            tx.oncomplete = () => resolve(request && 'result' in request ? request.result : undefined);
            tx.onerror = () => reject(tx.error || new Error('本地库读写失败'));
            tx.onabort = () => reject(tx.error || new Error('本地库操作被中断'));
        }));
    }

    function openSettingsDb() {
        if (settingsDbReady) return settingsDbReady;
        settingsDbReady = new Promise((resolve) => {
            if (typeof indexedDB === 'undefined' || !indexedDB) {
                resolve(null);
                return;
            }
            const request = indexedDB.open(SETTINGS_DB_NAME, SETTINGS_DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
                    db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
        });
        return settingsDbReady;
    }

    async function withSettingsStore(mode, callback) {
        const db = await openSettingsDb();
        if (!db) throw new Error('设置库不可用');
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SETTINGS_STORE, mode);
            const request = callback(tx.objectStore(SETTINGS_STORE));
            tx.oncomplete = () => resolve(request && 'result' in request ? request.result : undefined);
            tx.onerror = () => reject(tx.error || new Error('设置库读写失败'));
            tx.onabort = () => reject(tx.error || new Error('设置库操作被中断'));
        });
    }

    async function getStoredDownloadDirectory() {
        try {
            const row = await withSettingsStore('readonly', store => store.get(SETTINGS_DIRECTORY_KEY));
            return row && row.value ? row.value : null;
        } catch (_) {
            return null;
        }
    }

    async function storeDownloadDirectory(handle) {
        await withSettingsStore('readwrite', store => store.put({ key: SETTINGS_DIRECTORY_KEY, value: handle }));
    }

    async function removeStoredDownloadDirectory() {
        await withSettingsStore('readwrite', store => store.delete(SETTINGS_DIRECTORY_KEY));
    }

    async function hasDirectoryPermission(handle, request = false) {
        if (!handle) return false;
        try {
            const options = { mode: 'readwrite' };
            let state = await handle.queryPermission(options);
            if (state === 'granted') return true;
            if (!request) return false;
            state = await handle.requestPermission(options);
            return state === 'granted';
        } catch (_) {
            return false;
        }
    }

    function hashString(value) {
        let hash = 2166136261;
        const text = String(value || '');
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function formatBytes(size) {
        const bytes = Number(size) || 0;
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    }

    function mimeForExt(ext) {
        const types = {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            webp: 'image/webp',
            gif: 'image/gif',
            mp4: 'video/mp4',
            webm: 'video/webm',
            mov: 'video/quicktime',
            mp3: 'audio/mpeg',
            mpeg: 'audio/mpeg',
            wav: 'audio/wav',
            ogg: 'audio/ogg',
            m4a: 'audio/mp4',
            glb: 'model/gltf-binary',
            stl: 'model/stl',
            obj: 'text/plain'
        };
        return types[String(ext || '').toLowerCase()] || 'application/octet-stream';
    }

    async function requestBlob(url) {
        if (!url) throw new Error('结果地址为空');
        if (/^data:/i.test(url)) {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`本地数据读取失败：HTTP ${response.status}`);
            return response.blob();
        }
        try {
            const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
            if (response.ok) {
                const blob = await response.blob();
                if (blob.size > 0) return blob;
            }
        } catch (_) {}
        const response = await makeRequest({
            method: 'GET',
            url,
            responseType: 'arraybuffer',
            timeout: 120000
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`结果下载失败：HTTP ${response.status}`);
        }
        const body = response.response;
        if (!body || !body.byteLength) throw new Error('结果下载内容为空');
        let mime = '';
        try {
            const rawHeaders = String(response.responseHeaders || '');
            const match = rawHeaders.match(/content-type:\s*([^\r\n;]+)/i);
            if (match) mime = match[1].trim();
        } catch (_) {}
        return new Blob([body], { type: mime || mimeForExt(extFromUrl(url, 'bin')) });
    }

    function waitForMedia(element, eventName, url) {
        return new Promise(resolve => {
            const cleanup = () => {
                clearTimeout(timer);
                element.removeEventListener(eventName, onReady);
                element.removeEventListener('error', onError);
            };
            const onReady = () => {
                cleanup();
                resolve(true);
            };
            const onError = () => {
                cleanup();
                resolve(false);
            };
            const timer = setTimeout(() => {
                cleanup();
                resolve(false);
            }, 8000);
            element.addEventListener(eventName, onReady);
            element.addEventListener('error', onError);
            element.src = url;
            element.load?.();
        });
    }

    async function probeMedia(blob, kind) {
        if (!blob || (kind !== 'image' && kind !== 'video' && kind !== 'audio')) {
            return { width: undefined, height: undefined, duration: undefined };
        }
        const url = URL.createObjectURL(blob);
        try {
            if (kind === 'image') {
                const image = new Image();
                await waitForMedia(image, 'load', url);
                return { width: image.naturalWidth || undefined, height: image.naturalHeight || undefined, duration: undefined };
            }
            const element = document.createElement(kind === 'video' ? 'video' : 'audio');
            element.preload = 'metadata';
            element.muted = true;
            await waitForMedia(element, 'loadedmetadata', url);
            const duration = Number.isFinite(element.duration) ? Math.round(element.duration * 10) / 10 : undefined;
            return {
                width: kind === 'video' ? (element.videoWidth || undefined) : undefined,
                height: kind === 'video' ? (element.videoHeight || undefined) : undefined,
                duration
            };
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    // 今日日期键
    function getTodayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // 内存中的实时额度状态
    let currentQuotaState = null;

    // 从页面 DOM / React 树深度提取【每日免费体验 100 次，剩余 XX 次】
    function extractLiveQuotaFromPage(forceFromDOM = false) {
        if (!forceFromDOM && currentQuotaState && currentQuotaState.date === getTodayKey()) {
            return currentQuotaState;
        }

        let domQuota = null;
        // 非 Gitee 页面没有额度组件，且全量扫描大页面 DOM 会卡顿，直接使用本地记录
        if (IS_GITEE_HOST) try {
            // 1. 扫描 DOM 文本节点
            const elements = Array.from(document.querySelectorAll('*'));
            for (const el of elements) {
                const text = (el.innerText || '').trim();
                if (text.includes('每日免费体验') && text.includes('剩余')) {
                    const match = text.match(/(?:每日免费体验|免费体验)[^\d]*(\d+)[^\d]*次[，,\s]*剩余[^\d]*(\d+)[^\d]*次/);
                    if (match) {
                        const total = parseInt(match[1], 10);
                        const remaining = parseInt(match[2], 10);
                        domQuota = { date: getTodayKey(), total, remaining, used: total - remaining };
                        break;
                    }
                }
            }

            // 2. 扫描 React Fiber 树
            if (!domQuota) {
                for (const el of elements.slice(0, 120)) {
                    const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
                    if (!fiberKey) continue;
                    let curr = el[fiberKey];
                    while (curr) {
                        if (curr.memoizedProps) {
                            const str = JSON.stringify(curr.memoizedProps);
                            if (str && str.includes('每日免费体验')) {
                                const m = str.match(/(?:每日免费体验|免费体验)[^\d]*(\d+)[^\d]*次[，,\s]*剩余[^\d]*(\d+)[^\d]*次/);
                                if (m) {
                                    const total = parseInt(m[1], 10);
                                    const remaining = parseInt(m[2], 10);
                                    domQuota = { date: getTodayKey(), total, remaining, used: total - remaining };
                                    break;
                                }
                            }
                        }
                        curr = curr.return;
                    }
                    if (domQuota) break;
                }
            }
        } catch (e) {
            console.warn('[Z-Image] Live quota extraction warning:', e);
        }

        // 3. 读取本地已保存的今日额度
        try {
            const raw = safeGM.getValue(STORAGE_QUOTA_KEY, '') || localStorage.getItem(STORAGE_QUOTA_KEY);
            if (raw) {
                const savedData = JSON.parse(raw);
                if (savedData && savedData.date === getTodayKey()) {
                    if (forceFromDOM && domQuota) {
                        currentQuotaState = domQuota;
                    } else if (domQuota) {
                        const minRemaining = Math.min(domQuota.remaining, savedData.remaining);
                        currentQuotaState = {
                            date: getTodayKey(),
                            total: domQuota.total || 100,
                            remaining: minRemaining,
                            used: (domQuota.total || 100) - minRemaining
                        };
                    } else {
                        currentQuotaState = savedData;
                    }
                    const qStr = JSON.stringify(currentQuotaState);
                    safeGM.setValue(STORAGE_QUOTA_KEY, qStr);
                    return currentQuotaState;
                }
            }
        } catch(e) {}

        currentQuotaState = domQuota || { date: getTodayKey(), total: 100, remaining: 100, used: 0 };
        try {
            const qStr = JSON.stringify(currentQuotaState);
            safeGM.setValue(STORAGE_QUOTA_KEY, qStr);
        } catch(e) {}
        return currentQuotaState;
    }

    // 同步更新页面宿主 DOM 上的剩余次数展示
    function syncHostPageQuotaDOM(remaining) {
        if (!IS_GITEE_HOST) return;
        try {
            const elements = Array.from(document.querySelectorAll('*'));
            for (const el of elements) {
                if ((el.innerText || '').includes('每日免费体验') && (el.innerText || '').includes('剩余')) {
                    const redSpan = el.querySelector('.text-red-600') || el.querySelector('span');
                    if (redSpan) {
                        redSpan.innerText = String(remaining);
                    }
                }
            }
        } catch(e) {}
    }

    // 消费一次额度并即时更新
    function consumeOneQuota() {
        const quota = extractLiveQuotaFromPage();
        if (typeof quota.remaining === 'number' && quota.remaining > 0) {
            quota.remaining -= 1;
            quota.used = (quota.used || 0) + 1;
        } else {
            quota.used = (quota.used || 0) + 1;
        }
        currentQuotaState = quota;
        try {
            const qStr = JSON.stringify(quota);
            safeGM.setValue(STORAGE_QUOTA_KEY, qStr);
            localStorage.setItem(STORAGE_QUOTA_KEY, qStr);
        } catch(e) {}
        syncHostPageQuotaDOM(quota.remaining);
        return quota;
    }

    // 清理 Token（自动去除 Bearer 前缀、引号、多余空白）
    function cleanToken(t) {
        if (!t || typeof t !== 'string') return '';
        return t.trim().replace(/^Bearer\s+/i, '').replace(/["'`]/g, '').trim();
    }

    // 从页面 React Fiber 树中提取官方页面挂载的【免费体验访问令牌】
    function extractTokenFromReactFiber() {
        try {
            const allElements = Array.from(document.querySelectorAll('button, div, span, [role="button"]'));
            const candidateElements = allElements.filter(el => {
                const text = el.innerText || '';
                return text.includes('免费体验访问令牌') || text.includes('体验') || text.includes('令牌');
            });

            const targets = candidateElements.length > 0 ? candidateElements : allElements.slice(0, 60);

            for (const el of targets) {
                const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));
                if (!fiberKey) continue;

                const visited = new Set();
                const queue = [el[fiberKey]];

                while (queue.length > 0) {
                    const item = queue.shift();
                    if (!item || typeof item !== 'object' || visited.has(item)) continue;
                    visited.add(item);

                    for (const [k, v] of Object.entries(item)) {
                        if (typeof v === 'string') {
                            const cleaned = cleanToken(v);
                            if (/^[A-Z0-9]{36,44}$/.test(cleaned) && !cleaned.includes('_') && !DUMMY_TOKENS.includes(cleaned)) {
                                const kLower = k.toLowerCase();
                                if (kLower.includes('token') || kLower.includes('key') || k === 'value' || k === 'api_key') {
                                    return cleaned;
                                }
                            }
                        } else if (typeof v === 'object' && v !== null && !visited.has(v) && visited.size < 1500) {
                            queue.push(v);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[Z-Image] Fiber extraction warning:', e);
        }
        return null;
    }

    // 综合自动探测有效 Token；skipFiber=true 时跳过 React 树深扫（页面加载时的轻量预填用）
    function autoDetectToken(skipFiber = false) {
        const savedRaw = safeGM.getValuePrivate(STORAGE_TOKEN_KEY, '');
        const saved = cleanToken(savedRaw);
        if (saved && /^[A-Z0-9]{36,44}$/.test(saved) && !DUMMY_TOKENS.includes(saved)) {
            return saved;
        }

        // 非 Gitee 页面不做页面级探测（React 树 / localStorage 都是当前站点的数据），
        // 令牌请手动粘贴，或通过「🤖 Agent 提示词」查看接入方式获取
        if (!IS_GITEE_HOST) return '';

        if (!skipFiber) {
            const fiberToken = extractTokenFromReactFiber();
            if (fiberToken) {
                return fiberToken;
            }
        }

        return '';
    }

    // 注入独立样式
    const style = document.createElement('style');
    style.id = 'zimg-styles';
    style.textContent = `
        #zimg-floating-btn {
            position: fixed;
            right: 24px;
            bottom: 80px;
            z-index: 2147483646;
            background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
            color: #ffffff !important;
            padding: 10px 18px;
            border-radius: 30px;
            box-shadow: 0 6px 22px rgba(79, 70, 229, 0.45);
            cursor: grab;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            font-weight: 600;
            user-select: none;
            transition: box-shadow 0.25s, transform 0.15s;
            border: 1px solid rgba(255, 255, 255, 0.35);
            backdrop-filter: blur(10px);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif !important;
        }
        #zimg-floating-btn:hover {
            box-shadow: 0 10px 28px rgba(79, 70, 229, 0.65);
            transform: scale(1.04);
        }
        #zimg-floating-btn:active {
            cursor: grabbing;
            transform: scale(0.98);
        }

        #zimg-modal-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(15, 23, 42, 0.7);
            backdrop-filter: blur(6px);
            z-index: 2147483646;
            display: none;
            justify-content: center;
            align-items: center;
            padding: 20px;
            box-sizing: border-box;
            animation: zimgFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }

        #zimg-modal {
            background: #ffffff !important;
            width: 100%;
            max-width: 820px;
            max-height: 92vh;
            border-radius: 16px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif !important;
            color: #0f172a !important;
            box-sizing: border-box;
            border: 1px solid rgba(226, 232, 240, 0.8);
        }

        .zimg-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px 24px;
            background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
            border-bottom: 1px solid #e2e8f0;
        }
        .zimg-title {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 17px;
            font-weight: 700;
            color: #0f172a !important;
        }
        .zimg-badge {
            font-size: 11px;
            padding: 3px 9px;
            background: #e0e7ff;
            color: #4338ca !important;
            border-radius: 999px;
            font-weight: 600;
            letter-spacing: 0.3px;
        }
        .zimg-quota-badge {
            font-size: 12px;
            padding: 4px 11px;
            background: #ecfdf5;
            color: #059669 !important;
            border: 1px solid #a7f3d0;
            border-radius: 999px;
            font-weight: 600;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            transition: all 0.2s;
        }
        .zimg-close-btn {
            background: transparent;
            border: none;
            font-size: 20px;
            cursor: pointer;
            color: #64748b !important;
            line-height: 1;
            padding: 6px 10px;
            border-radius: 6px;
            transition: all 0.15s;
        }
        .zimg-close-btn:hover {
            background: #fee2e2;
            color: #ef4444 !important;
        }

        .zimg-body {
            padding: 20px 24px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 16px;
            background: #ffffff !important;
        }

        .zimg-field {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .zimg-label-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .zimg-label {
            font-size: 13px;
            font-weight: 600;
            color: #334155 !important;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .zimg-label-sub {
            font-size: 12px;
            font-weight: normal;
            color: #64748b !important;
        }
        .zimg-label-link {
            font-size: 12px;
            color: #4f46e5 !important;
            text-decoration: none;
            font-weight: 500;
        }
        .zimg-label-link:hover { text-decoration: underline; }

        .zimg-input-row {
            display: flex;
            gap: 8px;
        }
        .zimg-input {
            width: 100%;
            padding: 10px 12px;
            border: 1px solid #cbd5e1 !important;
            border-radius: 8px;
            font-size: 13px;
            font-family: inherit !important;
            transition: border-color 0.2s, box-shadow 0.2s;
            box-sizing: border-box;
            background: #ffffff !important;
            color: #0f172a !important;
        }
        .zimg-input:focus {
            outline: none;
            border-color: #6366f1 !important;
            box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
        }
        .zimg-textarea {
            width: 100%;
            min-height: 90px;
            padding: 10px 12px;
            border: 1px solid #cbd5e1 !important;
            border-radius: 8px;
            font-size: 13px;
            line-height: 1.5;
            resize: vertical;
            box-sizing: border-box;
            font-family: inherit !important;
            background: #ffffff !important;
            color: #0f172a !important;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        .zimg-textarea:focus {
            outline: none;
            border-color: #6366f1 !important;
            box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
        }

        .zimg-tags {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        .zimg-tag {
            font-size: 11px;
            padding: 4px 10px;
            background: #f1f5f9;
            border: 1px solid #e2e8f0;
            border-radius: 6px;
            color: #475569 !important;
            cursor: pointer;
            transition: all 0.15s;
            user-select: none;
        }
        .zimg-tag:hover {
            background: #e0e7ff;
            color: #4338ca !important;
            border-color: #c7d2fe;
        }

        .zimg-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
        }
        .zimg-grid-three {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 12px;
        }
        .zimg-segmented {
            display: grid;
            grid-template-columns: repeat(7, minmax(0, 1fr));
            background: #f1f5f9;
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            padding: 4px;
            gap: 4px;
        }
        .zimg-mode-tab {
            border: 0;
            background: transparent;
            color: #475569 !important;
            font-size: 12px;
            font-weight: 650;
            padding: 9px 6px;
            border-radius: 7px;
            cursor: pointer;
            white-space: nowrap;
            transition: all .18s ease;
        }
        .zimg-mode-tab.active {
            background: #ffffff;
            color: #4338ca !important;
            box-shadow: 0 1px 5px rgba(15, 23, 42, .12);
        }
        .zimg-panel { display: none; }
        .zimg-panel.active { display: block; }
        .zimg-file-label {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            min-height: 82px;
            border: 1px dashed #94a3b8;
            border-radius: 8px;
            background: #f8fafc;
            color: #475569 !important;
            cursor: pointer;
            text-align: center;
            padding: 10px;
            font-size: 13px;
        }
        .zimg-file-label.has-file {
            border-style: solid;
            border-color: #22c55e;
            background: #f0fdf4;
            color: #166534 !important;
        }
        .zimg-file-input { display: none; }
        .zimg-range {
            width: 100%;
            margin: 8px 0 0;
            accent-color: #4f46e5;
        }
        .zimg-switch-row {
            display: flex;
            align-items: center;
            gap: 8px;
            min-height: 38px;
            font-size: 13px;
            color: #334155 !important;
        }
        .zimg-model-note {
            font-size: 11px;
            color: #64748b !important;
            margin-top: 5px;
        }

        .zimg-action-btn {
            background: linear-gradient(135deg, #4f46e5 0%, #6366f1 100%);
            color: #ffffff !important;
            border: none;
            padding: 13px;
            border-radius: 8px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 8px;
            transition: all 0.2s;
            user-select: none;
            box-shadow: 0 4px 12px rgba(79, 70, 229, 0.25);
        }
        .zimg-action-btn:hover:not(:disabled) {
            opacity: 0.95;
            box-shadow: 0 6px 18px rgba(79, 70, 229, 0.4);
            transform: translateY(-1px);
        }
        .zimg-action-btn:disabled {
            background: #94a3b8 !important;
            cursor: not-allowed;
            opacity: 0.7;
            transform: none;
        }

        .zimg-small-btn {
            padding: 8px 14px;
            background: #f8fafc;
            border: 1px solid #cbd5e1;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 500;
            color: #334155 !important;
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.15s, border-color 0.15s;
            user-select: none;
        }
        .zimg-small-btn:hover {
            background: #f1f5f9;
            border-color: #94a3b8;
        }

        .zimg-status {
            padding: 12px 16px;
            border-radius: 8px;
            font-size: 13px;
            display: none;
            line-height: 1.5;
        }
        .zimg-status.loading { display: flex; align-items: center; gap: 10px; background: #fffbeb; color: #92400e !important; border: 1px solid #fde68a; }
        .zimg-status.error   { display: block; background: #fef2f2; color: #991b1b !important; border: 1px solid #fecaca; }
        .zimg-status.success { display: block; background: #f0fdf4; color: #166534 !important; border: 1px solid #bbf7d0; }

        .zimg-result-container {
            display: none;
            flex-direction: column;
            align-items: center;
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            padding: 16px;
            gap: 12px;
        }
        .zimg-preview-img {
            max-width: 100%;
            max-height: 420px;
            object-fit: contain;
            border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.1);
            background: #ffffff;
        }
        .zimg-media-frame {
            width: 100%;
            background: #0f172a;
            border-radius: 8px;
            overflow: hidden;
        }
        .zimg-video {
            display: block;
            width: 100%;
            max-height: 420px;
            background: #000;
        }
        .zimg-audio {
            display: block;
            width: 100%;
            margin: 24px 0;
        }
        .zimg-file-card {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 18px;
            color: #e2e8f0 !important;
            font-size: 13px;
        }
        .zimg-text-result {
            width: 100%;
            max-height: 420px;
            overflow-y: auto;
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 14px 16px;
            font-size: 13px;
            line-height: 1.75;
            white-space: pre-wrap;
            word-break: break-word;
            text-align: left;
            color: #0f172a !important;
            box-sizing: border-box;
            animation: zimgFadeIn 0.2s ease;
        }
        .zimg-thumb-chip {
            width: 60px;
            height: 60px;
            border-radius: 8px;
            border: 2px solid transparent;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #e2e8f0;
            font-size: 20px;
            cursor: pointer;
            flex-shrink: 0;
        }
        .zimg-thumb-chip:hover { border-color: #6366f1; transform: scale(1.06); }
        .zimg-result-ops {
            display: flex;
            gap: 10px;
            width: 100%;
            justify-content: center;
            flex-wrap: wrap;
        }
        .zimg-download-btn {
            background: #16a34a;
            color: #ffffff !important;
            border: none;
            padding: 9px 22px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background 0.2s;
        }
        .zimg-download-btn:hover { background: #15803d; }

        .zimg-history-strip {
            display: flex;
            gap: 10px;
            overflow-x: auto;
            padding: 8px 2px;
        }
        .zimg-library-controls {
            display: grid;
            grid-template-columns: minmax(0, 1fr) 108px;
            gap: 8px;
            margin-bottom: 10px;
        }
        .zimg-library-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
            gap: 10px;
        }
        .zimg-library-item {
            position: relative;
            width: 100%;
            aspect-ratio: 1 / 1;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            overflow: hidden;
            background: #f8fafc;
            cursor: pointer;
        }
        .zimg-library-item:hover { border-color: #6366f1; box-shadow: 0 4px 12px rgba(79,70,229,.14); }
        .zimg-library-item img {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        .zimg-library-chip,
        .zimg-library-badge {
            position: absolute;
            left: 6px;
            bottom: 6px;
            max-width: calc(100% - 12px);
            padding: 2px 5px;
            border-radius: 5px;
            background: rgba(15,23,42,.78);
            color: #fff !important;
            font-size: 10px;
            line-height: 1.3;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .zimg-library-chip { position: static; display: flex; align-items: center; justify-content: center; height: 100%; font-size: 20px; }
        .zimg-library-badge { top: 6px; bottom: auto; background: rgba(79,70,229,.92); }
        .zimg-library-delete {
            position: absolute;
            top: 4px;
            right: 4px;
            width: 20px;
            height: 20px;
            border: 0;
            border-radius: 5px;
            background: rgba(220,38,38,.92);
            color: #fff !important;
            font-size: 11px;
            line-height: 20px;
            cursor: pointer;
        }
        .zimg-library-empty {
            grid-column: 1 / -1;
            padding: 18px;
            border: 1px dashed #cbd5e1;
            border-radius: 8px;
            text-align: center;
            color: #64748b !important;
            font-size: 12px;
        }
        .zimg-cloud-summary {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 10px;
            color: #475569 !important;
            font-size: 12px;
        }
        .zimg-cloud-pill {
            padding: 3px 8px;
            border: 1px solid #e2e8f0;
            border-radius: 999px;
            background: #f8fafc;
            white-space: nowrap;
        }
        .zimg-cloud-task {
            min-width: 0;
            padding: 8px;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            background: #ffffff;
        }
        .zimg-cloud-id {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 11px;
            font-weight: 700;
        }
        .zimg-cloud-meta {
            margin-top: 3px;
            color: #64748b !important;
            font-size: 10px;
            line-height: 1.35;
        }
        .zimg-cloud-import {
            width: 100%;
            height: 24px;
            margin-top: 6px;
            border: 0;
            border-radius: 5px;
            background: #16a34a;
            color: #fff !important;
            font-size: 10px;
            cursor: pointer;
        }
        .zimg-cloud-import:disabled { opacity: .55; cursor: wait; }
        .zimg-cloud-actions { display: flex; gap: 4px; margin-top: 6px; }
        .zimg-cloud-actions > button {
            flex: 1;
            height: 24px;
            margin-top: 0;
            border: 0;
            border-radius: 5px;
            color: #fff !important;
            font-size: 10px;
            cursor: pointer;
        }
        .zimg-cloud-action-preview { background: #4f46e5; }
        .zimg-cloud-action-cancel { background: #dc2626; }
        .zimg-cloud-action-dismiss { background: #64748b; }
        .zimg-cloud-actions > button:disabled { opacity: .55; cursor: wait; }
        .zimg-cloud-status-success { color: #15803d !important; font-weight: 700; }
        .zimg-cloud-status-failure,
        .zimg-cloud-status-cancelled { color: #dc2626 !important; font-weight: 700; }
        .zimg-cloud-status-in_progress,
        .zimg-cloud-status-waiting { color: #d97706 !important; font-weight: 700; }
        .zimg-thumb {
            width: 60px;
            height: 60px;
            border-radius: 8px;
            object-fit: cover;
            border: 2px solid transparent;
            cursor: pointer;
            transition: all 0.15s;
            flex-shrink: 0;
            background: #e2e8f0;
        }
        .zimg-thumb:hover { border-color: #6366f1; transform: scale(1.06); }

        .zimg-spinner {
            width: 16px; height: 16px;
            border: 2px solid #b45309;
            border-top-color: transparent;
            border-radius: 50%;
            animation: zimgSpin 0.8s linear infinite;
            flex-shrink: 0;
        }
        @keyframes zimgSpin { to { transform: rotate(360deg); } }
        @keyframes zimgFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes zimgPopIn {
            from { opacity: 0; transform: translateY(14px) scale(0.97); }
            to { opacity: 1; transform: none; }
        }
        #zimg-modal, #zimg-agent-modal { animation: zimgPopIn 0.22s cubic-bezier(0.16, 1, 0.3, 1); }
        #zimg-console-modal { animation: zimgPopIn 0.22s cubic-bezier(0.16, 1, 0.3, 1); }

        /* 窄屏 / 移动端适配：面板铺满、参数网格降为单列、标签页换行 */
        @media (max-width: 640px) {
            #zimg-modal, #zimg-agent-modal, #zimg-console-modal { max-width: 100%; max-height: 96vh; border-radius: 12px; }
            .zimg-header { padding: 12px 14px; flex-wrap: wrap; gap: 8px; }
            .zimg-title { font-size: 15px; flex-wrap: wrap; }
            .zimg-body { padding: 14px; }
            .zimg-grid, .zimg-grid-three { grid-template-columns: 1fr; }
            .zimg-segmented { grid-template-columns: repeat(4, minmax(0, 1fr)); }
            .zimg-input-row { flex-wrap: wrap; }
            .zimg-result-ops { flex-direction: column; }
            .zimg-result-ops .zimg-download-btn, .zimg-result-ops .zimg-small-btn { width: 100%; justify-content: center; }
            .zimg-agent-ops { flex-wrap: wrap; }
            #zimg-floating-btn { right: 14px; bottom: 60px; padding: 9px 14px; font-size: 13px; }
        }

        #zimg-agent-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(15, 23, 42, 0.7);
            backdrop-filter: blur(6px);
            z-index: 2147483647;
            display: none;
            justify-content: center;
            align-items: center;
            padding: 20px;
            box-sizing: border-box;
            animation: zimgFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        }
        #zimg-agent-modal {
            background: #ffffff !important;
            width: 100%;
            max-width: 720px;
            max-height: 88vh;
            border-radius: 16px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif !important;
            color: #0f172a !important;
            box-sizing: border-box;
            border: 1px solid rgba(226, 232, 240, 0.8);
        }
        .zimg-agent-body {
            padding: 20px 24px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 14px;
            background: #ffffff !important;
        }
        .zimg-agent-hint {
            font-size: 12px;
            color: #64748b !important;
            background: #f8fafc;
            border: 1px dashed #cbd5e1;
            padding: 10px 12px;
            border-radius: 8px;
            line-height: 1.7;
            word-break: break-all;
        }
        .zimg-agent-ops { display: flex; gap: 10px; flex-wrap: wrap; }
        .zimg-agent-textarea {
            width: 100%;
            min-height: 320px;
            padding: 12px;
            border: 1px solid #cbd5e1 !important;
            border-radius: 8px;
            font-size: 12px;
            line-height: 1.6;
            font-family: Consolas, Monaco, "Courier New", monospace !important;
            background: #f8fafc !important;
            color: #0f172a !important;
            box-sizing: border-box;
            resize: vertical;
            white-space: pre;
        }
        .zimg-agent-token-row {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: #334155 !important;
        }
        #zimg-console-overlay {
            position: fixed;
            inset: 0;
            background: rgba(15, 23, 42, 0.72);
            backdrop-filter: blur(6px);
            z-index: 2147483647;
            display: none;
            justify-content: center;
            align-items: center;
            padding: 18px;
            box-sizing: border-box;
        }
        #zimg-console-modal {
            background: #ffffff !important;
            width: min(1080px, 100%);
            max-height: 92vh;
            border-radius: 14px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            color: #0f172a !important;
            border: 1px solid rgba(226, 232, 240, 0.8);
        }
        .zimg-console-body {
            padding: 16px 20px 20px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 14px;
        }
        .zimg-console-grid {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: 14px;
            align-items: start;
        }
        .zimg-console-form {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
        }
        .zimg-console-field { min-width: 0; }
        .zimg-console-wide { grid-column: 1 / -1; }
        .zimg-console-meta {
            font-size: 12px;
            line-height: 1.65;
            color: #475569 !important;
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 10px 12px;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .zimg-console-code {
            width: 100%;
            min-height: 180px;
            resize: vertical;
            box-sizing: border-box;
            font-family: Consolas, Monaco, "Courier New", monospace !important;
            font-size: 12px;
            line-height: 1.55;
        }
        .zimg-console-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        @media (max-width: 900px) {
            .zimg-console-grid, .zimg-console-form { grid-template-columns: 1fr; }
        }
        .zimg-badge-gitee {
            font-size: 10px;
            padding: 2px 7px;
            border-radius: 999px;
            background: #ecfdf5;
            color: #059669 !important;
            border: 1px solid #a7f3d0;
            font-weight: 600;
        }
    `;
    (document.head || document.documentElement).appendChild(style);

    // 悬浮按钮构建与拖拽
    const fab = document.createElement('div');
    fab.id = 'zimg-floating-btn';
    fab.innerHTML = `🎨 <span>AI 生成台</span>`;
    fab.title = '打开 Gitee AI 多模型生成工作台（可自由拖动位置）';
    document.body.appendChild(fab);

    // 恢复悬浮按钮位置
    try {
        const savedPos = safeGM.getValue(STORAGE_FAB_POS, '') || localStorage.getItem(STORAGE_FAB_POS);
        if (savedPos) {
            const { top, left } = JSON.parse(savedPos);
            if (top && left) {
                fab.style.top = top;
                fab.style.left = left;
                fab.style.right = 'auto';
                fab.style.bottom = 'auto';
            }
        }
    } catch(e) {}

    // 悬浮按钮拖拽逻辑
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let fabStartX = 0, fabStartY = 0;
    let hasMoved = false;

    function beginFabDrag(clientX, clientY) {
        isDragging = true;
        hasMoved = false;
        dragStartX = clientX;
        dragStartY = clientY;
        const rect = fab.getBoundingClientRect();
        fabStartX = rect.left;
        fabStartY = rect.top;
        fab.style.transition = 'none';
    }

    function moveFabDrag(clientX, clientY) {
        if (!isDragging) return false;
        const dx = clientX - dragStartX;
        const dy = clientY - dragStartY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        let nextLeft = fabStartX + dx;
        let nextTop = fabStartY + dy;
        nextLeft = Math.max(10, Math.min(window.innerWidth - fab.offsetWidth - 10, nextLeft));
        nextTop = Math.max(10, Math.min(window.innerHeight - fab.offsetHeight - 10, nextTop));
        fab.style.left = nextLeft + 'px';
        fab.style.top = nextTop + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        return hasMoved;
    }

    function endFabDrag() {
        if (!isDragging) return;
        isDragging = false;
        fab.style.transition = 'box-shadow 0.25s, transform 0.15s';
        if (hasMoved) {
            try {
                const posStr = JSON.stringify({ top: fab.style.top, left: fab.style.left });
                safeGM.setValue(STORAGE_FAB_POS, posStr);
            } catch(e) {}
        }
    }

    fab.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        beginFabDrag(e.clientX, e.clientY);
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        moveFabDrag(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', endFabDrag);

    // 触屏设备：拖动时阻止页面滚动，轻点仍可打开面板
    fab.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        beginFabDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
        if (!isDragging || e.touches.length !== 1) return;
        if (moveFabDrag(e.touches[0].clientX, e.touches[0].clientY)) {
            e.preventDefault();
        }
    }, { passive: false });

    window.addEventListener('touchend', endFabDrag);

    // 模态弹窗构建
    const overlay = document.createElement('div');
    overlay.id = 'zimg-modal-overlay';
    overlay.innerHTML = `
        <div id="zimg-modal">
            <div class="zimg-header">
                <div class="zimg-title">
                    <span>🎨 Gitee AI 生成工作台</span>
                    <span class="zimg-badge">Serverless API</span>
                    <span class="zimg-quota-badge" id="zimg-header-quota-badge">✅ 访问令牌已就绪</span>
                </div>
                <button class="zimg-close-btn" id="zimg-btn-close" title="关闭 (Esc)">✕</button>
            </div>

            <div class="zimg-body">
                <!-- Token 配置 -->
                <div class="zimg-field">
                    <div class="zimg-label-row">
                        <span class="zimg-label">🔑 访问令牌 (Token) / 额度状态</span>
                        <a class="zimg-label-link" href="https://ai.gitee.com/serverless-api" target="_blank" rel="noopener noreferrer">获取专属 API Key ↗</a>
                    </div>
                    <div class="zimg-input-row">
                        <input type="password" id="zimg-token-input" class="zimg-input" placeholder="自动获取访问令牌，或粘贴个人 API Key..." />
                        <button class="zimg-small-btn" id="zimg-btn-toggle-pwd" title="查看/隐藏令牌">👁</button>
                        <button class="zimg-small-btn" id="zimg-btn-console" title="按官方元数据生成全参数表单，支持同步/异步调用与任务控制">🧪 全参数</button>
                        <button class="zimg-small-btn" id="zimg-btn-agent-prompt" title="生成 API 调用指南（Markdown），保存到项目后 Codex / Claude Code 等 Agent 可直接调用接口">🤖 Agent 提示词</button>
                        <button class="zimg-small-btn" id="zimg-btn-refresh-token" title="重新自动获取访问令牌（仅 Gitee 站点有效）">🔄 自动同步</button>
                    </div>
                    <div class="zimg-label-row" style="margin-top: 2px;">
                        <span class="zimg-label-sub" id="zimg-token-mode-desc">模式：🔑 API 访问令牌（打开面板时自动获取）</span>
                        <span class="zimg-label-sub" id="zimg-usage-summary">已生成: 0 次</span>
                    </div>
                </div>

                <!-- 模型类型 -->
                <div class="zimg-segmented" id="zimg-mode-tabs">
                    <button class="zimg-mode-tab active" data-mode="image">🖼 文生图</button>
                    <button class="zimg-mode-tab" data-mode="textVideo">🎬 文生视频</button>
                    <button class="zimg-mode-tab" data-mode="imageVideo">📹 图生视频</button>
                    <button class="zimg-mode-tab" data-mode="speech">🔊 语音</button>
                    <button class="zimg-mode-tab" data-mode="threeD">🧊 3D</button>
                    <button class="zimg-mode-tab" data-mode="chat">💬 对话</button>
                    <button class="zimg-mode-tab" data-mode="asr">🎙 识别</button>
                </div>

                <!-- Prompt / Text -->
                <div class="zimg-field">
                    <div class="zimg-label-row">
                        <span class="zimg-label" id="zimg-prompt-label">💬 提示词（Prompt）</span>
                        <span class="zimg-label-sub">中英文支持 · <b style="color:#4f46e5;">Ctrl+Enter</b> 快捷生成</span>
                    </div>
                    <textarea id="zimg-prompt-input" class="zimg-textarea" placeholder="例如：一个赛博朋克风格的未来中国都市，雨夜霓虹倒影，飞行列车穿梭，高清细节，8k超清壁纸..."></textarea>

                    <div class="zimg-tags" id="zimg-prompt-tags">
                        <span class="zimg-tag" data-modes="image,textVideo,imageVideo" data-p="超写实肖像摄影，柔和自然光，精致面部细节，单反质感，大师级作品">📸 写实人像</span>
                        <span class="zimg-tag" data-modes="image,textVideo,imageVideo" data-p="赛博朋克夜景都市，未来科技感，霓虹光晕，飞行载具，雨夜湿地倒影">🌆 赛博朋克</span>
                        <span class="zimg-tag" data-modes="image,textVideo,imageVideo" data-p="国风唯美水墨山水画，云雾缭绕，仙鹤飞翔，青绿山水，意境悠远">⛰️ 国风山水</span>
                        <span class="zimg-tag" data-modes="speech" data-p="你好，这是一段清晰自然的中文语音测试。">🗣 自然播报</span>
                        <span class="zimg-tag" data-modes="speech" data-p="欢迎回来。今天的数据已经同步完成，需要我现在开始汇报吗？">📞 助手语气</span>
                        <span class="zimg-tag" data-modes="chat" data-p="用通俗的语言解释什么是扩散模型，并举一个生活中的类比。">🧠 知识问答</span>
                        <span class="zimg-tag" data-modes="chat" data-p="写一首关于秋日黄昏的现代诗，四到八行，意境悠远。">✍️ 写一首诗</span>
                        <span class="zimg-tag" data-modes="chat" data-p="一个笼子里有鸡和兔共 35 个头、94 只脚，问鸡兔各几只？请一步步推理。">🔢 趣味推理</span>
                    </div>
                </div>

                <div class="zimg-field" id="zimg-negative-field">
                    <div class="zimg-label-row"><span class="zimg-label">🚫 反向提示词</span><span class="zimg-label-sub">可留空</span></div>
                    <input type="text" id="zimg-negative-input" class="zimg-input" placeholder="不希望出现的内容..." />
                </div>

                <div class="zimg-panel active" id="zimg-panel-image">
                    <div class="zimg-field">
                        <div class="zimg-label-row"><span class="zimg-label">🖼 图片模型</span></div>
                        <select id="zimg-model-image" class="zimg-input"></select>
                        <div class="zimg-model-note" id="zimg-image-note"></div>
                    </div>
                    <div class="zimg-grid" style="margin-top:16px;">
                        <div class="zimg-field">
                            <div class="zimg-label-row"><span class="zimg-label">📐 尺寸</span><span class="zimg-label-sub">以所选模型元数据为准</span></div>
                            <select id="zimg-size-select" class="zimg-input">
                                <option value="512x512">512 × 512（快速）</option>
                                <option value="1024x1024" selected>1024 × 1024（默认高清）</option>
                                <option value="1024x768">1024 × 768（4:3）</option>
                                <option value="768x1024">768 × 1024（3:4）</option>
                                <option value="1536x864">1536 × 864（16:9）</option>
                                <option value="2048x2048">2048 × 2048（超清）</option>
                            </select>
                        </div>
                        <div class="zimg-field">
                            <div class="zimg-label-row">
                                <span class="zimg-label">⚡ 步数</span>
                                <span class="zimg-label-sub">Steps: <b id="zimg-steps-val" style="color:#4f46e5;">9</b></span>
                            </div>
                            <input type="range" id="zimg-steps-slider" class="zimg-range" min="4" max="20" value="9" />
                        </div>
                    </div>
                    <div class="zimg-grid" style="margin-top:16px;">
                        <div class="zimg-grid-three">
                            <div class="zimg-field"><span class="zimg-label">🎯 Guidance</span><input type="number" id="zimg-image-guidance" class="zimg-input" step="0.1" min="0" placeholder="自动" /></div>
                            <div class="zimg-field"><span class="zimg-label">🎲 Seed</span><input type="number" id="zimg-image-seed" class="zimg-input" placeholder="随机" /></div>
                            <div class="zimg-field"><span class="zimg-label">🔢 数量</span><select id="zimg-image-count" class="zimg-input"><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
                        </div>
                        <div class="zimg-field">
                            <div class="zimg-label-row"><span class="zimg-label">📤 返回格式</span><span class="zimg-label-sub">Base64 不依赖 CDN，链接不过期</span></div>
                            <select id="zimg-image-format" class="zimg-input">
                                <option value="url" selected>URL（默认，响应更轻量）</option>
                                <option value="b64_json">Base64（内嵌图片数据）</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div class="zimg-panel" id="zimg-panel-textVideo">
                    <div class="zimg-field">
                        <div class="zimg-label-row"><span class="zimg-label">🎬 视频模型</span></div>
                        <select id="zimg-model-text-video" class="zimg-input"></select>
                    </div>
                    <div class="zimg-grid-three" style="margin-top:16px;">
                        <div class="zimg-field" id="zimg-t2v-aspect-field"><span class="zimg-label">🖼 画面比例</span><select id="zimg-t2v-aspect" class="zimg-input"><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option></select></div>
                        <div class="zimg-field" id="zimg-t2v-fps-field"><span class="zimg-label">🎞 FPS</span><select id="zimg-t2v-fps" class="zimg-input"><option value="16" selected>16</option><option value="24">24</option></select></div>
                        <div class="zimg-field"><span class="zimg-label">🖼 帧数</span><select id="zimg-t2v-frames" class="zimg-input"><option value="81" selected>81</option><option value="49">49</option><option value="33">33</option></select></div>
                    </div>
                    <div class="zimg-grid" style="margin-top:16px;">
                        <div class="zimg-field">
                            <div class="zimg-label-row"><span class="zimg-label">⚡ 步数</span><span class="zimg-label-sub"><b id="zimg-t2v-steps-val" style="color:#4f46e5;">4</b></span></div>
                            <input type="range" id="zimg-t2v-steps" class="zimg-range" min="1" max="30" value="4" />
                        </div>
                        <div class="zimg-field"><span class="zimg-label">🎲 Seed</span><input type="number" id="zimg-t2v-seed" class="zimg-input" placeholder="随机" /></div>
                    </div>
                </div>

                <div class="zimg-panel" id="zimg-panel-imageVideo">
                    <label class="zimg-file-label" for="zimg-i2v-file" id="zimg-i2v-file-label">🖼 点击选择参考图<span id="zimg-i2v-file-name"></span></label>
                    <input type="file" id="zimg-i2v-file" class="zimg-file-input" accept="image/*" />
                    <div class="zimg-field" style="margin-top:16px;"><span class="zimg-label">📹 图生视频模型</span><select id="zimg-model-image-video" class="zimg-input"></select></div>
                    <div class="zimg-grid-three" style="margin-top:16px;">
                        <div class="zimg-field"><span class="zimg-label">🖼 宽度</span><input type="number" id="zimg-i2v-width" class="zimg-input" value="512" min="256" max="2048" step="1" /></div>
                        <div class="zimg-field"><span class="zimg-label">📏 高度</span><input type="number" id="zimg-i2v-height" class="zimg-input" value="512" min="256" max="2048" step="1" /></div>
                        <div class="zimg-field"><span class="zimg-label">🖼 帧数</span><select id="zimg-i2v-frames" class="zimg-input"><option value="73">73</option><option value="33">33</option><option value="25">25</option></select></div>
                    </div>
                    <div class="zimg-grid-three" style="margin-top:16px;">
                        <div class="zimg-field" id="zimg-i2v-fps-field"><span class="zimg-label">🎞 FPS</span><select id="zimg-i2v-fps" class="zimg-input"><option value="24" selected>24</option><option value="16">16</option><option value="32">32</option></select></div>
                        <div class="zimg-field" id="zimg-i2v-guidance-field"><span class="zimg-label">🎯 Guidance</span><input type="number" id="zimg-i2v-guidance" class="zimg-input" value="5" step="0.1" /></div>
                        <div class="zimg-field">
                            <div class="zimg-label-row"><span class="zimg-label">⚡ 步数</span><span class="zimg-label-sub"><b id="zimg-i2v-steps-val" style="color:#4f46e5;">8</b></span></div>
                            <input type="range" id="zimg-i2v-steps" class="zimg-range" min="1" max="30" value="8" />
                        </div>
                    </div>
                    <div class="zimg-grid" style="margin-top:16px;">
                        <div class="zimg-field">
                            <div class="zimg-label-row"><span class="zimg-label">🧭 分辨率预设</span><span class="zimg-label-sub">视频元数据上限为 2048</span></div>
                            <select id="zimg-i2v-resolution" class="zimg-input">
                                <option value="">自定义</option>
                                <option value="512x512" selected>512 × 512（快速）</option>
                                <option value="1280x720">1280 × 720（HD）</option>
                                <option value="1920x1080">1920 × 1080（FHD）</option>
                            </select>
                        </div>
                        <div class="zimg-field"><span class="zimg-label">🎲 Seed</span><input type="number" id="zimg-i2v-seed" class="zimg-input" placeholder="随机" /></div>
                    </div>
                </div>

                <div class="zimg-panel" id="zimg-panel-speech">
                    <div class="zimg-field">
                        <div class="zimg-label-row">
                            <span class="zimg-label">🔊 语音模型 <span class="zimg-badge-gitee" style="font-size:10px;">🆓 免费</span></span>
                        </div>
                        <select id="zimg-model-speech" class="zimg-input"></select>
                        <div class="zimg-model-note">🆓 Spark TTS 支持男女声、音调与语速调节。</div>
                    </div>
                    <div class="zimg-grid" style="margin-top:16px;">
                        <div class="zimg-field">
                            <div class="zimg-label-row"><span class="zimg-label">🚻 音色性别</span></div>
                            <select id="zimg-speech-gender" class="zimg-input"><option value="female" selected>Female</option><option value="male">Male</option></select>
                        </div>
                        <div class="zimg-field">
                            <div class="zimg-label-row"><span class="zimg-label">🎚 音调</span><span class="zimg-label-sub"><b id="zimg-speech-pitch-val" style="color:#4f46e5;">3</b>/5</span></div>
                            <input type="range" id="zimg-speech-pitch" class="zimg-range" min="1" max="5" value="3" />
                        </div>
                    </div>
                    <div class="zimg-field" style="margin-top:16px;">
                        <div class="zimg-label-row"><span class="zimg-label">🎚 语速</span><span class="zimg-label-sub"><b id="zimg-speech-speed-val" style="color:#4f46e5;">3</b>/5</span></div>
                        <input type="range" id="zimg-speech-speed" class="zimg-range" min="1" max="5" value="3" />
                    </div>
                </div>

                <div class="zimg-panel" id="zimg-panel-threeD">
                    <label class="zimg-file-label" for="zimg-3d-file" id="zimg-3d-file-label">🧊 点击选择源图片<span id="zimg-3d-file-name"></span></label>
                    <input type="file" id="zimg-3d-file" class="zimg-file-input" accept="image/*" />
                    <div class="zimg-field" style="margin-top:16px;"><span class="zimg-label">🧊 3D 模型</span><select id="zimg-model-three-d" class="zimg-input"></select></div>
                    <div class="zimg-grid-three" style="margin-top:16px;">
                        <div class="zimg-field" id="zimg-3d-format-field"><span class="zimg-label">📦 格式</span><select id="zimg-3d-format" class="zimg-input"><option value="glb" selected>GLB</option><option value="stl">STL</option></select></div>
                        <div class="zimg-field" id="zimg-3d-octree-field"><span class="zimg-label">🕸 Octree</span><select id="zimg-3d-octree" class="zimg-input"><option value="64">64</option><option value="128" selected>128</option><option value="256">256</option></select></div>
                        <div class="zimg-field" id="zimg-3d-guidance-field"><span class="zimg-label">🎯 Guidance</span><input type="number" id="zimg-3d-guidance" class="zimg-input" value="5" step="0.1" /></div>
                    </div>
                    <div class="zimg-grid" style="margin-top:16px;">
                        <div class="zimg-field">
                            <div class="zimg-label-row"><span class="zimg-label">⚡ 步数</span><span class="zimg-label-sub"><b id="zimg-3d-steps-val" style="color:#4f46e5;">5</b></span></div>
                            <input type="range" id="zimg-3d-steps" class="zimg-range" min="1" max="20" value="5" />
                        </div>
                        <div class="zimg-switch-row" id="zimg-3d-texture-field"><input type="checkbox" id="zimg-3d-texture" checked /><span>生成纹理</span></div>
                    </div>
                    <div class="zimg-field" style="margin-top:16px;"><span class="zimg-label">🎲 Seed</span><input type="number" id="zimg-3d-seed" class="zimg-input" value="1234" /></div>
                    <div id="zimg-3d-advanced-field" style="margin-top:16px;">
                        <div class="zimg-grid-three">
                            <div class="zimg-field"><span class="zimg-label">🧊 MC 分辨率</span><input type="number" id="zimg-3d-mc-resolution" class="zimg-input" value="512" min="64" step="32" /></div>
                            <div class="zimg-field"><span class="zimg-label">🔺 面数上限</span><input type="number" id="zimg-3d-face-count" class="zimg-input" value="80000" min="1000" step="1000" /></div>
                            <div class="zimg-switch-row"><input type="checkbox" id="zimg-3d-foreground" checked /><span>前景检测（白底图建议开）</span></div>
                        </div>
                        <div class="zimg-model-note">网格重建精度参数：MC 分辨率与面数越高网格越精细，耗时与文件体积也越大。</div>
                    </div>
                </div>

                <div class="zimg-panel" id="zimg-panel-chat">
                    <div class="zimg-field">
                        <div class="zimg-label-row">
                            <span class="zimg-label">💬 对话模型 <span class="zimg-badge-gitee" style="font-size:10px;">🆓 免费</span></span>
                            <span class="zimg-label-sub" id="zimg-chat-state">尚未开始</span>
                        </div>
                        <select id="zimg-model-chat" class="zimg-input"></select>
                        <div class="zimg-model-note">🆓 此分类全部免费：Qwen3 / GLM4 / DeepSeek-R1 蒸馏 / 书生·浦语 / 医疗与数学专用模型。多轮对话自动携带上下文。</div>
                    </div>
                    <div class="zimg-grid" style="margin-top:16px;">
                        <div class="zimg-field"><span class="zimg-label">🧭 系统提示词</span><input type="text" id="zimg-chat-system" class="zimg-input" placeholder="可选，如：你是一位简洁的中文助手" /></div>
                        <div class="zimg-field">
                            <div class="zimg-label-row"><span class="zimg-label">🌡 Temperature</span><span class="zimg-label-sub">0 - 2</span></div>
                            <input type="number" id="zimg-chat-temp" class="zimg-input" value="0.7" step="0.1" min="0" max="2" />
                        </div>
                    </div>
                    <div class="zimg-grid" style="margin-top:16px;">
                        <div class="zimg-field"><span class="zimg-label">📏 Max Tokens</span><input type="number" id="zimg-chat-max-tokens" class="zimg-input" placeholder="默认（由模型决定）" min="1" /></div>
                        <div class="zimg-field">
                            <div class="zimg-label-row"><span class="zimg-label">🔄 对话状态</span><span class="zimg-label-sub" id="zimg-btn-new-chat" style="cursor:pointer;color:#4f46e5;font-weight:600;">🧹 开始新对话</span></div>
                            <span class="zimg-label-sub">上下文最多保留最近 10 轮</span>
                        </div>
                    </div>
                    <div class="zimg-grid-three" style="margin-top:16px;">
                        <div class="zimg-field"><span class="zimg-label">🎯 Top P</span><input type="number" id="zimg-chat-top-p" class="zimg-input" step="0.05" min="0" max="1" placeholder="默认" /></div>
                        <div class="zimg-field"><span class="zimg-label">📉 频率惩罚</span><input type="number" id="zimg-chat-freq-penalty" class="zimg-input" step="0.1" min="-2" max="2" placeholder="默认 0" /></div>
                        <div class="zimg-field"><span class="zimg-label">📈 重复惩罚</span><input type="number" id="zimg-chat-pres-penalty" class="zimg-input" step="0.1" min="-2" max="2" placeholder="默认 0" /></div>
                    </div>
                    <div class="zimg-switch-row" style="margin-top:12px;">
                        <input type="checkbox" id="zimg-chat-stream" checked />
                        <span>流式输出（打字机效果，逐字返回，长回复不用干等）</span>
                    </div>
                </div>

                <div class="zimg-panel" id="zimg-panel-asr">
                    <label class="zimg-file-label" for="zimg-asr-file" id="zimg-asr-file-label">🎙 点击选择音频文件<span id="zimg-asr-file-name"></span></label>
                    <input type="file" id="zimg-asr-file" class="zimg-file-input" accept="audio/*" />
                    <div class="zimg-field" style="margin-top:16px;">
                        <div class="zimg-label-row">
                            <span class="zimg-label">🎙 识别模型 <span class="zimg-badge-gitee" style="font-size:10px;">🆓 免费</span></span>
                        </div>
                        <select id="zimg-model-asr" class="zimg-input"></select>
                        <div class="zimg-model-note">🆓 GLM-ASR 为超轻量中文识别；SenseVoiceSmall 支持中/英/日/韩等多语种。支持 mp3 / wav / m4a 等常见音频格式。</div>
                    </div>
                    <div class="zimg-grid" style="margin-top:16px;">
                        <div class="zimg-field">
                            <div class="zimg-label-row"><span class="zimg-label">🌐 音频语言</span><span class="zimg-label-sub">留空则自动检测</span></div>
                            <select id="zimg-asr-language" class="zimg-input">
                                <option value="" selected>自动检测</option>
                                <option value="zh">中文</option>
                                <option value="en">英语</option>
                                <option value="ja">日语</option>
                                <option value="ko">韩语</option>
                                <option value="yue">粤语</option>
                                <option value="vi">越南语</option>
                                <option value="fr">法语</option>
                                <option value="de">德语</option>
                                <option value="es">西班牙语</option>
                                <option value="ru">俄语</option>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- 操作 -->
                <div style="display:flex;gap:10px;align-items:center;">
                    <button class="zimg-action-btn" id="zimg-btn-generate" style="flex:1;">
                        <span id="zimg-generate-label">✨ 开始生成图片</span>
                    </button>
                    <button class="zimg-small-btn" id="zimg-btn-cancel" style="display:none;height:44px;">⛔ 取消任务</button>
                </div>
                <!-- 状态消息 -->
                <div class="zimg-status" id="zimg-status"></div>

                <!-- 结果展示区 -->
                <div class="zimg-result-container" id="zimg-result-box">
                    <img id="zimg-preview-img" class="zimg-preview-img" alt="生成结果" />
                    <video id="zimg-preview-video" class="zimg-media-frame zimg-video" controls style="display:none;"></video>
                    <audio id="zimg-preview-audio" class="zimg-audio" controls style="display:none;"></audio>
                    <div id="zimg-preview-text" class="zimg-text-result" style="display:none;"></div>
                    <div class="zimg-media-frame zimg-file-card" id="zimg-preview-file-card" style="display:none;"><span id="zimg-file-kind">📄 Generated file</span><span id="zimg-file-name-text"></span></div>
                    <div class="zimg-result-ops">
                        <button class="zimg-download-btn" id="zimg-btn-download">⬇ 下载结果</button>
                        <button class="zimg-small-btn" id="zimg-btn-copy-link">📋 复制链接</button>
                    </div>
                </div>

                <!-- 自动保存目录设置 -->
                <div class="zimg-field" id="zimg-save-directory-section">
                    <div class="zimg-label-row">
                        <span class="zimg-label">💾 自动保存目录</span>
                        <span class="zimg-label-sub" id="zimg-save-dir-status">检查浏览器支持…</span>
                    </div>
                    <div class="zimg-library-controls" style="grid-template-columns:auto auto;">
                        <button class="zimg-small-btn" id="zimg-btn-choose-save-dir">📁 选择目录</button>
                        <button class="zimg-small-btn" id="zimg-btn-clear-save-dir" disabled>🗑 清除目录</button>
                    </div>
                </div>

                <!-- 历史生成画廊 -->
                <div class="zimg-field" id="zimg-cloud-task-section">
                    <div class="zimg-label-row">
                        <span class="zimg-label">☁️ 云端异步任务 <span class="zimg-label-sub" id="zimg-cloud-task-count"></span></span>
                        <span class="zimg-label-sub">近 24 小时 · 官方任务列表</span>
                    </div>
                    <div class="zimg-library-controls" style="grid-template-columns:auto auto;">
                        <button class="zimg-small-btn" id="zimg-btn-refresh-tasks">🔄 刷新云端任务</button>
                        <button class="zimg-small-btn" id="zimg-btn-import-success" disabled>📥 导入全部成功</button>
                    </div>
                    <div class="zimg-cloud-summary" id="zimg-cloud-task-summary"></div>
                    <div class="zimg-library-grid" id="zimg-cloud-task-strip"></div>
                </div>

                <div class="zimg-field" id="zimg-history-section" style="display:none;">
                    <div class="zimg-label-row">
                        <span class="zimg-label">🗂 本地库 <span class="zimg-label-sub" id="zimg-library-count"></span></span>
                        <span class="zimg-label-sub" style="cursor:pointer;" id="zimg-btn-clear-history">清空本地库</span>
                    </div>
                    <div class="zimg-library-controls">
                        <input type="search" id="zimg-library-search" class="zimg-input" placeholder="搜索提示词、模型或任务 ID" />
                        <select id="zimg-library-type" class="zimg-input">
                            <option value="all">全部类型</option>
                            <option value="image">图片</option>
                            <option value="video">视频</option>
                            <option value="audio">音频</option>
                            <option value="model">3D</option>
                            <option value="text">文本</option>
                        </select>
                    </div>
                    <div class="zimg-library-grid" id="zimg-history-strip"></div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Agent 提示词导出弹窗：生成 Markdown 接口指南，供 Codex / Claude Code 等 Agent 软件调用
    const agentOverlay = document.createElement('div');
    agentOverlay.id = 'zimg-agent-overlay';
    agentOverlay.innerHTML = `
        <div id="zimg-agent-modal">
            <div class="zimg-header">
                <div class="zimg-title"><span>🤖 Agent 提示词 / 接口调用指南</span></div>
                <button class="zimg-close-btn" id="zimg-agent-close" title="关闭 (Esc)">✕</button>
            </div>
            <div class="zimg-agent-body">
                <div class="zimg-agent-hint">
                    📄 下方是一份 Markdown 接口指南（含认证方式、全部端点、模型清单与 curl 示例）。<br />
                    · 下载后放到项目里（如 <b>docs/gitee-ai-agents.md</b>，或并入 <b>AGENTS.md / CLAUDE.md</b>），Codex、Claude Code 等 Agent 读到即可直接调用这些接口；<br />
                    · 也可直接复制全文粘贴给任何 Agent 使用；<br />
                    · 文档在本地生成，<b>不会上传到任何服务器</b>。
                </div>
                <textarea id="zimg-agent-text" class="zimg-agent-textarea" readonly spellcheck="false"></textarea>
                <div class="zimg-agent-ops">
                    <button class="zimg-download-btn" id="zimg-agent-download" style="flex:1;justify-content:center;">⬇ 下载 gitee-ai-agents.md</button>
                    <button class="zimg-small-btn" id="zimg-agent-copy" style="height:40px;">📋 复制全文</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(agentOverlay);

    const consoleOverlay = document.createElement('div');
    consoleOverlay.id = 'zimg-console-overlay';
    consoleOverlay.innerHTML = `
        <div id="zimg-console-modal">
            <div class="zimg-header">
                <div class="zimg-title"><span>🧪 全参数控制台</span><span class="zimg-badge">官方元数据</span></div>
                <button class="zimg-close-btn" id="zimg-console-close" title="关闭 (Esc)">✕</button>
            </div>
            <div class="zimg-console-body">
                <div class="zimg-console-grid">
                    <div>
                        <div class="zimg-field"><span class="zimg-label">接口</span><select id="zimg-console-endpoint" class="zimg-input"></select></div>
                        <div class="zimg-field" style="margin-top:10px;"><span class="zimg-label">模型 / 操作</span><select id="zimg-console-operation" class="zimg-input"></select></div>
                        <div class="zimg-toolbar" style="margin-top:10px;">
                            <button class="zimg-small-btn" id="zimg-console-refresh">🔄 刷新 OpenAPI</button>
                            <button class="zimg-small-btn" id="zimg-console-query">🔍 查询方法</button>
                        </div>
                    </div>
                    <div class="zimg-console-meta" id="zimg-console-source">正在加载官方参数元数据…</div>
                </div>
                <div class="zimg-console-form" id="zimg-console-form"></div>
                <label class="zimg-switch-row" id="zimg-console-paid-row" style="display:none;"><input type="checkbox" id="zimg-console-paid-confirm" /><span>我确认这是付费模型调用，并已接受可能产生的费用。</span></label>
                <div class="zimg-console-grid">
                    <div>
                        <div class="zimg-label-row"><span class="zimg-label">请求预览</span><span class="zimg-label-sub">自动随表单更新</span></div>
                        <textarea id="zimg-console-preview" class="zimg-input zimg-console-code" readonly></textarea>
                    </div>
                    <div>
                        <div class="zimg-label-row"><span class="zimg-label">响应 / 结果</span><span class="zimg-label-sub" id="zimg-console-state">待调用</span></div>
                        <textarea id="zimg-console-response" class="zimg-input zimg-console-code"></textarea>
                    </div>
                </div>
                <div class="zimg-console-grid">
                    <div class="zimg-field"><span class="zimg-label">异步任务 ID</span><input type="text" id="zimg-console-task-id" class="zimg-input" placeholder="提交异步接口后返回的 task_id" /></div>
                    <div class="zimg-console-toolbar" style="align-items:end;">
                        <button class="zimg-small-btn" id="zimg-console-task-get">📋 查询任务</button>
                        <button class="zimg-small-btn" id="zimg-console-task-status">📊 状态</button>
                        <button class="zimg-small-btn" id="zimg-console-task-cancel">⛔ 取消</button>
                    </div>
                </div>
                <div style="display:flex;gap:10px;">
                    <button class="zimg-action-btn" id="zimg-console-send" style="flex:1;">🚀 发送请求</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(consoleOverlay);

    // 逻辑绑定
    const tokenInput = document.getElementById('zimg-token-input');
    const tokenModeDesc = document.getElementById('zimg-token-mode-desc');
    const headerQuotaBadge = document.getElementById('zimg-header-quota-badge');
    const usageSummary = document.getElementById('zimg-usage-summary');
    const promptInput = document.getElementById('zimg-prompt-input');
    const promptField = promptInput.closest('.zimg-field');
    const promptTags = document.getElementById('zimg-prompt-tags');
    const promptLabel = document.getElementById('zimg-prompt-label');
    const negativeField = document.getElementById('zimg-negative-field');
    const negativeInput = document.getElementById('zimg-negative-input');
    const generateLabel = document.getElementById('zimg-generate-label');
    const cancelBtn = document.getElementById('zimg-btn-cancel');
    const sizeSelect = document.getElementById('zimg-size-select');
    const stepsSlider = document.getElementById('zimg-steps-slider');
    const stepsVal = document.getElementById('zimg-steps-val');
    const generateBtn = document.getElementById('zimg-btn-generate');
    const statusBox = document.getElementById('zimg-status');
    const resultBox = document.getElementById('zimg-result-box');
    const previewImg = document.getElementById('zimg-preview-img');
    const previewVideo = document.getElementById('zimg-preview-video');
    const previewAudio = document.getElementById('zimg-preview-audio');
    const previewText = document.getElementById('zimg-preview-text');
    const previewFileCard = document.getElementById('zimg-preview-file-card');
    const fileKindText = document.getElementById('zimg-file-kind');
    const fileNameText = document.getElementById('zimg-file-name-text');
    const downloadBtn = document.getElementById('zimg-btn-download');
    const copyLinkBtn = document.getElementById('zimg-btn-copy-link');
    const historySection = document.getElementById('zimg-history-section');
    const historyStrip = document.getElementById('zimg-history-strip');
    const clearHistoryBtn = document.getElementById('zimg-btn-clear-history');
    const libraryCount = document.getElementById('zimg-library-count');
    const librarySearch = document.getElementById('zimg-library-search');
    const libraryType = document.getElementById('zimg-library-type');
    const chooseSaveDirBtn = document.getElementById('zimg-btn-choose-save-dir');
    const clearSaveDirBtn = document.getElementById('zimg-btn-clear-save-dir');
    const saveDirStatus = document.getElementById('zimg-save-dir-status');
    const cloudTaskCount = document.getElementById('zimg-cloud-task-count');
    const cloudTaskSummary = document.getElementById('zimg-cloud-task-summary');
    const cloudTaskStrip = document.getElementById('zimg-cloud-task-strip');
    const refreshTasksBtn = document.getElementById('zimg-btn-refresh-tasks');
    const importSuccessBtn = document.getElementById('zimg-btn-import-success');

    let currentResult = null;
    let currentMode = 'image';
    let activeTaskId = null;
    let activeTaskUrls = null;
    let cancelRequested = false;
    let currentObjectUrl = '';

    function releaseCurrentObjectUrl() {
        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = '';
        }
    }

    librarySearch.addEventListener('input', () => {
        libraryQuery = librarySearch.value.trim().toLowerCase();
        renderLibrary();
    });
    libraryType.addEventListener('change', () => {
        libraryFilter = libraryType.value;
        renderLibrary();
    });

    Object.keys(MODEL_REGISTRY).forEach(mode => {
        const select = document.getElementById(`zimg-model-${mode === 'textVideo' ? 'text-video' : mode === 'imageVideo' ? 'image-video' : mode === 'threeD' ? 'three-d' : mode}`);
        const verified = MODEL_REGISTRY[mode].models.filter(model => model.verified);
        const catalog = MODEL_REGISTRY[mode].models.filter(model => !model.verified);
        [verified, catalog].forEach((models, index) => {
            if (!models.length) return;
            const group = document.createElement('optgroup');
            group.label = index === 0 ? '实测通过' : '目录可试用';
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.value;
                option.textContent = model.name;
                group.appendChild(option);
            });
            select.appendChild(group);
        });
    });

    // 刷新并直接同步顶部徽章与模式文本
    function updateQuotaDisplay(quotaOverride) {
        const quota = quotaOverride || extractLiveQuotaFromPage(false);
        const token = cleanToken(tokenInput.value);

        if (!token) {
            headerQuotaBadge.innerText = `⚠️ 未配置令牌`;
            headerQuotaBadge.style.background = '#fef2f2';
            headerQuotaBadge.style.color = '#dc2626';
            headerQuotaBadge.style.borderColor = '#fecaca';
            tokenModeDesc.innerHTML = `模式：<span style="color:#dc2626;font-weight:600;">未配置令牌</span>`;
            usageSummary.innerText = `已生成: ${quota.used || 0} 次`;
        } else {
            headerQuotaBadge.innerText = `✅ 令牌已配置`;
            headerQuotaBadge.style.background = '#ecfdf5';
            headerQuotaBadge.style.color = '#059669';
            headerQuotaBadge.style.borderColor = '#a7f3d0';
            tokenModeDesc.innerHTML = `模式：<span style="color:#16a34a;font-weight:600;">🔑 API 访问令牌</span>（来自当前页面探测或私有存储）`;
            usageSummary.innerText = `今日已生成: ${quota.used || 0} 次`;
        }
    }

    tokenInput.addEventListener('input', () => updateQuotaDisplay());

    function setSliderValue(slider, valueElement) {
        valueElement.innerText = slider.value;
    }
    [
        [stepsSlider, stepsVal],
        [document.getElementById('zimg-t2v-steps'), document.getElementById('zimg-t2v-steps-val')],
        [document.getElementById('zimg-i2v-steps'), document.getElementById('zimg-i2v-steps-val')],
        [document.getElementById('zimg-speech-pitch'), document.getElementById('zimg-speech-pitch-val')],
        [document.getElementById('zimg-speech-speed'), document.getElementById('zimg-speech-speed-val')],
        [document.getElementById('zimg-3d-steps'), document.getElementById('zimg-3d-steps-val')]
    ].forEach(([slider, display]) => {
        slider.addEventListener('input', () => setSliderValue(slider, display));
    });

    const i2vWidthInput = document.getElementById('zimg-i2v-width');
    const i2vHeightInput = document.getElementById('zimg-i2v-height');
    const i2vResolutionSelect = document.getElementById('zimg-i2v-resolution');

    function syncImageVideoResolution() {
        const [width, height] = i2vResolutionSelect.value.split('x').map(Number);
        i2vWidthInput.value = width;
        i2vHeightInput.value = height;
    }

    function syncImageVideoPreset() {
        const value = `${i2vWidthInput.value}x${i2vHeightInput.value}`;
        i2vResolutionSelect.value = [...i2vResolutionSelect.options].some(option => option.value === value)
            ? value
            : '';
    }

    i2vResolutionSelect.addEventListener('change', syncImageVideoResolution);
    [i2vWidthInput, i2vHeightInput].forEach(input => input.addEventListener('input', syncImageVideoPreset));

    function getModelConfig(mode = currentMode) {
        return MODEL_REGISTRY[mode].models.find(model => model.value === getModeSelect(mode).value);
    }

    function getModeSelect(mode) {
        const ids = {
            image: 'zimg-model-image',
            textVideo: 'zimg-model-text-video',
            imageVideo: 'zimg-model-image-video',
            speech: 'zimg-model-speech',
            threeD: 'zimg-model-three-d',
            chat: 'zimg-model-chat',
            asr: 'zimg-model-asr'
        };
        return document.getElementById(ids[mode]);
    }

    function fillSelect(select, values, selected) {
        select.innerHTML = '';
        values.forEach(value => {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = String(value);
            option.selected = String(value) === String(selected);
            select.appendChild(option);
        });
    }

    function applyModelDefaults() {
        const config = getModelConfig();
        const modeSettings = {
            image: { slider: stepsSlider, display: stepsVal },
            textVideo: { slider: document.getElementById('zimg-t2v-steps'), display: document.getElementById('zimg-t2v-steps-val') },
            imageVideo: { slider: document.getElementById('zimg-i2v-steps'), display: document.getElementById('zimg-i2v-steps-val') },
            threeD: { slider: document.getElementById('zimg-3d-steps'), display: document.getElementById('zimg-3d-steps-val') }
        };
        const setting = modeSettings[currentMode];
        if (setting && config.steps) {
            setting.slider.min = config.steps[0];
            setting.slider.max = config.steps[1];
            setting.slider.value = config.steps[2];
            setting.display.innerText = config.steps[2];
        }

        const imageNote = document.getElementById('zimg-image-note');
        if (currentMode === 'image') {
            fillSelect(sizeSelect, QUICK_IMAGE_SIZES, '1024x1024');
            imageNote.innerText = config.verified ? '此模型已完成真实任务验证。' : '目录标记为可试用；不同模型对高级参数的兼容性可能有差异。';
        }

        if (currentMode === 'textVideo') {
            fillSelect(document.getElementById('zimg-t2v-frames'), config.frames || [33, 49, 81], (config.frames || []).slice(-1)[0] || 81);
            document.getElementById('zimg-t2v-aspect-field').style.display = config.aspect ? '' : 'none';
            document.getElementById('zimg-t2v-fps-field').style.display = config.fps ? '' : 'none';
        }

        if (currentMode === 'imageVideo') {
            fillSelect(document.getElementById('zimg-i2v-frames'), config.frames || [17, 25, 33, 73], (config.frames || []).slice(-1)[0] || 33);
            document.getElementById('zimg-i2v-fps-field').style.display = config.fps ? '' : 'none';
            document.getElementById('zimg-i2v-guidance-field').style.display = config.guidance ? '' : 'none';
        }

        if (currentMode === 'threeD') {
            document.getElementById('zimg-3d-format-field').style.display = config.format ? '' : 'none';
            const octreeField = document.getElementById('zimg-3d-octree-field');
            const guidanceField = document.getElementById('zimg-3d-guidance-field');
            const textureField = document.getElementById('zimg-3d-texture-field');
            const stepsField = document.getElementById('zimg-3d-steps').closest('.zimg-field');
            const advancedField = document.getElementById('zimg-3d-advanced-field');
            octreeField.style.display = config.octree ? '' : 'none';
            if (config.octree) {
                fillSelect(document.getElementById('zimg-3d-octree'), config.octree, config.octree[0]);
            }
            guidanceField.style.display = config.guidance ? '' : 'none';
            textureField.style.display = config.texture ? '' : 'none';
            stepsField.style.display = config.steps ? '' : 'none';
            if (advancedField) advancedField.style.display = config.advanced ? '' : 'none';
        }
    }

    function switchMode(mode) {
        currentMode = mode;
        document.querySelectorAll('.zimg-mode-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.mode === mode));
        document.querySelectorAll('.zimg-panel').forEach(panel => panel.classList.remove('active'));
        document.getElementById(`zimg-panel-${mode}`).classList.add('active');

        const isSpeech = mode === 'speech';
        const isThreeD = mode === 'threeD';
        const isChat = mode === 'chat';
        const isAsr = mode === 'asr';
        const hidePrompt = isThreeD || isAsr;
        promptField.style.display = hidePrompt ? 'none' : '';
        promptTags.style.display = hidePrompt ? 'none' : '';
        negativeField.style.display = (isSpeech || isThreeD || isChat || isAsr) ? 'none' : '';
        promptLabel.innerHTML = isSpeech ? '📝 合成文本' : (isChat ? '💬 输入消息（多轮对话）' : '💬 提示词（Prompt）');
        promptInput.placeholder = isSpeech
            ? '输入需要转换成语音的文本...'
            : isChat
                ? '输入你的问题或消息，Ctrl+Enter 快速发送...'
                : '描述画面、镜头、光线、风格和细节...';
        generateLabel.innerText = {
            image: '✨ 开始生成图片',
            textVideo: '🎬 开始生成视频',
            imageVideo: '📹 开始图生视频',
            speech: '🔊 开始合成语音',
            threeD: '🧊 开始生成 3D',
            chat: '💬 发送消息',
            asr: '🎙 开始识别'
        }[mode];
        document.querySelectorAll('#zimg-prompt-tags .zimg-tag').forEach(tag => {
            const modes = (tag.getAttribute('data-modes') || '').split(',');
            tag.style.display = modes.includes(mode) ? '' : 'none';
        });
        applyModelDefaults();
    }

    document.querySelectorAll('.zimg-mode-tab').forEach(tab => {
        tab.addEventListener('click', () => switchMode(tab.dataset.mode));
    });

    ['image', 'textVideo', 'imageVideo', 'speech', 'threeD', 'chat', 'asr'].forEach(mode => {
        getModeSelect(mode).addEventListener('change', () => {
            if (mode === currentMode) applyModelDefaults();
        });
    });

    function bindFileInput(inputId, labelId, nameId) {
        const input = document.getElementById(inputId);
        const label = document.getElementById(labelId);
        const name = document.getElementById(nameId);
        input.addEventListener('change', () => {
            const file = input.files[0];
            label.classList.toggle('has-file', !!file);
            name.innerText = file ? `：${file.name}` : '';
        });
    }
    bindFileInput('zimg-i2v-file', 'zimg-i2v-file-label', 'zimg-i2v-file-name');
    bindFileInput('zimg-3d-file', 'zimg-3d-file-label', 'zimg-3d-file-name');
    bindFileInput('zimg-asr-file', 'zimg-asr-file-label', 'zimg-asr-file-name');

    async function getLibraryItem(id) {
        return withLibrary('readonly', store => store.get(id));
    }

    async function saveLibraryItem(result, prompt, meta = {}) {
        const now = Date.now();
        const kind = result.kind || 'image';
        const ext = result.ext || extFromUrl(result.url, kind === 'text' ? 'txt' : 'bin');
        let blob = null;
        let text = '';
        let mime = mimeForExt(ext);
        let localState = 'remote';

        if (kind === 'text') {
            text = String(result.text || '');
            blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            mime = blob.type;
            localState = 'saved';
        } else if (result.blob) {
            blob = result.blob;
            mime = blob.type && blob.type !== 'application/octet-stream' ? blob.type : mime;
            localState = 'saved';
        } else if (result.url) {
            try {
                blob = await requestBlob(result.url);
                mime = blob.type && blob.type !== 'application/octet-stream' ? blob.type : mime;
                localState = 'saved';
            } catch (error) {
                console.warn('[Gitee AI Generator] 结果内容下载失败，保留远程地址', error);
            }
        }

        const probed = await probeMedia(blob, kind);
        const record = {
            id: `${now.toString(36)}-${hashString(`${result.url || text}|${prompt}|${Math.random()}`)}`,
            kind,
            ext,
            prompt: String(prompt || ''),
            mode: meta.mode || currentMode,
            model: meta.model || '',
            taskId: meta.taskId || '',
            sourceUrl: result.sourceUrl || result.url || '',
            filename: result.filename || `gitee-ai-${kind}-${now}.${ext}`,
            createdAt: now,
            blob,
            text,
            size: blob ? blob.size : 0,
            mime,
            width: probed.width,
            height: probed.height,
            duration: probed.duration,
            localState
        };
        await withLibrary('readwrite', store => store.put(record));
        libraryList.unshift(record);
        renderLibrary();
        if (downloadDirectoryHandle) {
            try {
                await saveRecordToDirectory(record);
            } catch (error) {
                console.warn('[Gitee AI Generator] 自动保存到目录失败', error);
                renderSaveDirectoryState(`保存失败：${error.message}`);
            }
        }
        return record.id;
    }

    function sanitizeFilename(value, fallback = 'gitee-ai-output') {
        const name = String(value || '')
            .split(/[\\/]/).pop()
            .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
            .replace(/^\.+/, '')
            .trim()
            .slice(0, 180)
            .trim();
        return name || fallback;
    }

    async function uniqueDirectoryFilename(handle, filename, ext) {
        const safe = sanitizeFilename(filename || `gitee-ai-${Date.now()}.${ext || 'bin'}`);
        const dot = safe.lastIndexOf('.');
        const base = dot > 0 ? safe.slice(0, dot) : safe;
        const extension = dot > 0 ? safe.slice(dot) : (ext ? `.${ext}` : '');
        for (let index = 0; index < 1000; index += 1) {
            const candidate = index ? `${base}-${index}${extension}` : safe;
            try {
                await handle.getFileHandle(candidate, { create: false });
            } catch (error) {
                if (error && error.name === 'NotFoundError') return candidate;
                throw error;
            }
        }
        throw new Error('无法生成不重复的文件名');
    }

    async function saveRecordToDirectory(record) {
        if (!downloadDirectoryHandle || !record.blob) return false;
        if (!(await hasDirectoryPermission(downloadDirectoryHandle))) {
            downloadDirectoryNeedsPermission = true;
            renderSaveDirectoryState('目录权限不足');
            throw new Error('需要重新授权保存目录');
        }
        const filename = await uniqueDirectoryFilename(downloadDirectoryHandle, record.filename, record.ext);
        const fileHandle = await downloadDirectoryHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(record.blob);
        await writable.close();
        record.savedFilename = filename;
        await withLibrary('readwrite', store => store.put(record));
        const existing = libraryList.find(item => item.id === record.id);
        if (existing) existing.savedFilename = filename;
        renderSaveDirectoryState(`最近已保存 ${filename}`);
        return true;
    }

    async function deleteRecordFile(record) {
        const filename = record && record.savedFilename;
        if (!downloadDirectoryHandle || !filename) return true;
        if (!(await hasDirectoryPermission(downloadDirectoryHandle, true))) {
            downloadDirectoryNeedsPermission = true;
            renderSaveDirectoryState('目录权限不足');
            return false;
        }
        try {
            await downloadDirectoryHandle.removeEntry(filename);
            renderSaveDirectoryState(`已删除 ${filename}`);
            return true;
        } catch (error) {
            if (error && error.name === 'NotFoundError') return true;
            renderSaveDirectoryState(`删除失败：${error.message}`);
            return false;
        }
    }

    function persistDismissedCloudTasks() {
        const values = Array.from(cloudTaskDismissed).slice(-1000);
        safeGM.setValue(STORAGE_DISMISSED_CLOUD_TASKS_KEY, JSON.stringify(values));
    }

    function renderSaveDirectoryState(message = '') {
        if (!saveDirStatus) return;
        const supported = typeof window.showDirectoryPicker === 'function';
        let text;
        if (!supported) {
            text = '当前浏览器不支持固定目录（仍保存到浏览器本地库）';
        } else if (!downloadDirectoryHandle) {
            text = '未设置（生成内容仍保存到浏览器本地库）';
        } else {
            text = `${downloadDirectoryHandle.name}${downloadDirectoryNeedsPermission ? ' · 需要重新授权' : ''}`;
        }
        if (message) text += ` · ${message}`;
        saveDirStatus.textContent = text;
        if (chooseSaveDirBtn) {
            chooseSaveDirBtn.disabled = !supported;
            chooseSaveDirBtn.textContent = supported && downloadDirectoryNeedsPermission ? '🔑 重新授权' : '📁 选择目录';
        }
        if (clearSaveDirBtn) clearSaveDirBtn.disabled = !supported || !downloadDirectoryHandle;
    }

    async function restoreDownloadDirectory() {
        try {
            const handle = await getStoredDownloadDirectory();
            downloadDirectoryHandle = handle;
            downloadDirectoryNeedsPermission = handle ? !(await hasDirectoryPermission(handle)) : false;
        } catch (error) {
            console.warn('[Gitee AI Generator] 恢复自动保存目录失败', error);
        } finally {
            renderSaveDirectoryState();
        }
    }

    async function chooseDownloadDirectory() {
        if (typeof window.showDirectoryPicker !== 'function') {
            showStatus('error', '❌ 当前浏览器不支持选择固定目录，请使用 Chrome / Edge 等基于 Chromium 的浏览器');
            return;
        }
        try {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'gitee-ai-workbench' });
            const granted = await hasDirectoryPermission(handle, true);
            if (!granted) throw new Error('未授予目录写入权限');
            downloadDirectoryHandle = handle;
            downloadDirectoryNeedsPermission = false;
            await storeDownloadDirectory(handle);
            renderSaveDirectoryState();
            showStatus('success', '✅ 新生成内容将自动保存到此目录');
            setTimeout(() => { if (!isGenerating) statusBox.style.display = 'none'; }, 2000);
        } catch (error) {
            if (error && error.name === 'AbortError') return;
            console.error('[Gitee AI Generator] 选择保存目录失败', error);
            showStatus('error', `❌ 选择保存目录失败：${error.message}`);
        }
    }

    async function clearDownloadDirectory() {
        try {
            await removeStoredDownloadDirectory();
            downloadDirectoryHandle = null;
            downloadDirectoryNeedsPermission = false;
            renderSaveDirectoryState();
            showStatus('success', '✅ 已清除自动保存目录');
            setTimeout(() => { if (!isGenerating) statusBox.style.display = 'none'; }, 1500);
        } catch (error) {
            console.error('[Gitee AI Generator] 清除保存目录失败', error);
            showStatus('error', `❌ 清除保存目录失败：${error.message}`);
        }
    }

    async function migrateLegacyHistory() {
        let legacyItems = [];
        try {
            const raw = safeGM.getValue(STORAGE_HISTORY_KEY, '') || localStorage.getItem(STORAGE_HISTORY_KEY);
            legacyItems = raw ? JSON.parse(raw) : [];
        } catch (_) {
            legacyItems = [];
        }
        if (!Array.isArray(legacyItems) || !legacyItems.length) return;

        for (const item of legacyItems) {
            const kind = (item.kind === 'file' ? 'model' : item.kind) || 'image';
            const prompt = String(item.prompt || '');
            const sourceUrl = String(item.url || '');
            const ext = item.ext || extFromUrl(sourceUrl, kind === 'text' ? 'txt' : 'bin');
            const record = {
                id: `legacy-${hashString(`${sourceUrl}|${prompt}|${kind}`)}`,
                kind,
                ext,
                prompt,
                mode: '',
                model: '',
                taskId: '',
                sourceUrl,
                filename: `legacy-${Date.now()}.${ext}`,
                createdAt: Date.now(),
                blob: null,
                text: kind === 'text' ? String(item.text || '') : '',
                size: 0,
                mime: mimeForExt(ext),
                width: undefined,
                height: undefined,
                duration: undefined,
                localState: kind === 'text' ? 'saved' : 'remote'
            };
            try {
                await withLibrary('readwrite', store => store.put(record));
            } catch (error) {
                console.warn('[Gitee AI Generator] 迁移历史记录失败', error);
            }
        }

        historyList = [];
        try {
            safeGM.setValue(STORAGE_HISTORY_KEY, '[]');
            localStorage.removeItem(STORAGE_HISTORY_KEY);
        } catch (_) {}
    }

    function initLibrary() {
        if (libraryInitPromise) return libraryInitPromise;
        libraryInitPromise = (async () => {
            await openLibrary();
            await migrateLegacyHistory();
            await refreshLibrary();
        })();
        libraryInitPromise.catch(error => {
            console.warn('[Gitee AI Generator] 本地库初始化失败', error);
        });
        return libraryInitPromise;
    }

    async function refreshLibrary() {
        const items = await withLibrary('readonly', store => store.getAll());
        libraryList = (items || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        renderLibrary();
    }

    function libraryMatches(item) {
        if (libraryFilter !== 'all' && item.kind !== libraryFilter) return false;
        if (!libraryQuery) return true;
        const haystack = [
            item.prompt,
            item.model,
            item.mode,
            item.taskId,
            item.filename,
            item.sourceUrl,
            item.ext,
            item.text
        ].filter(Boolean).join('\n').toLowerCase();
        return haystack.includes(libraryQuery);
    }

    function renderLibrary() {
        libraryObjectUrls.forEach(url => URL.revokeObjectURL(url));
        libraryObjectUrls = [];
        if (!libraryList.length) {
            historySection.style.display = 'none';
            return;
        }
        historySection.style.display = 'block';
        const items = libraryList.filter(libraryMatches);
        libraryCount.textContent = `${items.length} / ${libraryList.length}`;
        historyStrip.innerHTML = '';
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'zimg-library-empty';
            empty.textContent = '没有匹配的生成内容';
            historyStrip.appendChild(empty);
            return;
        }

        const kindLabels = { image: '图片', video: '视频', audio: '音频', model: '3D', text: '文本' };
        items.forEach((item) => {
            const card = document.createElement('div');
            card.className = 'zimg-library-item';
            card.title = [
                item.prompt || '(无提示词)',
                `类型：${kindLabels[item.kind] || item.kind}`,
                item.model ? `模型：${item.model}` : '',
                item.size ? `大小：${formatBytes(item.size)}` : '',
                item.width ? `尺寸：${item.width}×${item.height}` : '',
                item.duration ? `时长：${item.duration}s` : ''
            ].filter(Boolean).join('\n');

            if (item.kind === 'image') {
                const thumb = document.createElement('img');
                thumb.alt = item.prompt || '本地生成图片';
                if (item.blob) {
                    const objectUrl = URL.createObjectURL(item.blob);
                    libraryObjectUrls.push(objectUrl);
                    thumb.src = objectUrl;
                } else {
                    thumb.src = item.sourceUrl;
                }
                card.appendChild(thumb);
            } else {
                const chip = document.createElement('div');
                chip.className = 'zimg-library-chip';
                chip.textContent = { video: '🎬', audio: '🔊', model: '🧊', text: '💬' }[item.kind] || '📄';
                card.appendChild(chip);
            }

            const badge = document.createElement('span');
            badge.className = 'zimg-library-badge';
            badge.textContent = `${kindLabels[item.kind] || item.kind}${item.localState === 'remote' ? ' · 远程' : ''}`;
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'zimg-library-delete';
            deleteBtn.textContent = '✕';
            deleteBtn.title = '删除这条本地记录';
            deleteBtn.setAttribute('aria-label', '删除这条本地记录');
            deleteBtn.addEventListener('click', event => {
                event.stopPropagation();
                deleteLibraryItem(item.id);
            });
            card.addEventListener('click', () => openLibraryItem(item.id));
            card.append(badge, deleteBtn);
            historyStrip.appendChild(card);
        });
    }

    async function openLibraryItem(id) {
        try {
            const item = await getLibraryItem(id);
            if (!item) {
                await refreshLibrary();
                return;
            }
            let objectUrl = '';
            let result;
            if (item.kind === 'text') {
                result = { kind: 'text', text: item.text || '', ext: item.ext || 'txt' };
            } else if (item.blob) {
                releaseCurrentObjectUrl();
                objectUrl = URL.createObjectURL(item.blob);
                result = { url: objectUrl, kind: item.kind, ext: item.ext, filename: item.filename };
            } else {
                result = { url: item.sourceUrl, kind: item.kind, ext: item.ext, filename: item.filename };
            }
            result.sourceUrl = item.sourceUrl || '';
            showResult(result, item.prompt);
            currentObjectUrl = objectUrl;
            promptInput.value = item.prompt || '';
        } catch (error) {
            console.error('[Gitee AI Generator] 打开本地库内容失败', error);
            showStatus('error', `❌ 本地内容打开失败：${error.message}`);
        }
    }

    async function deleteLibraryItem(id) {
        try {
            const record = await getLibraryItem(id);
            if (!record) {
                await refreshLibrary();
                return;
            }
            if (record.savedFilename && downloadDirectoryHandle &&
                !(await deleteRecordFile(record))) {
                throw new Error('目录文件删除失败，请重新授权保存目录');
            }
            await withLibrary('readwrite', store => store.delete(id));
            await refreshLibrary();
            showStatus('success', '🗑 已删除这条本地记录');
            setTimeout(() => { if (!isGenerating) statusBox.style.display = 'none'; }, 1500);
        } catch (error) {
            console.error('[Gitee AI Generator] 删除本地库内容失败', error);
            showStatus('error', `❌ 删除失败：${error.message}`);
        }
    }

    async function addToHistory(result, p, meta = {}) {
        try {
            await saveLibraryItem(result, p, meta);
        } catch (error) {
            console.warn('[Gitee AI Generator] 本地库保存失败，仅保留远程结果', error);
        }
    }

    clearHistoryBtn.addEventListener('click', async () => {
        if (!confirm(`确定清空本地库中的 ${libraryList.length} 条生成内容？此操作不可恢复。`)) return;
        try {
            const records = [...libraryList];
            for (const record of records) {
                if (record.savedFilename && downloadDirectoryHandle &&
                    !(await deleteRecordFile(record))) {
                    throw new Error('目录文件删除失败，已保留本地记录');
                }
            }
            await withLibrary('readwrite', store => store.clear());
            historyList = [];
            safeGM.setValue(STORAGE_HISTORY_KEY, '[]');
            localStorage.removeItem(STORAGE_HISTORY_KEY);
            await refreshLibrary();
            showStatus('success', '🧹 本地库已清空');
            setTimeout(() => { if (!isGenerating) statusBox.style.display = 'none'; }, 1500);
        } catch (error) {
            console.error('[Gitee AI Generator] 清空本地库失败', error);
            showStatus('error', `❌ 本地库清空失败：${error.message}`);
        }
    });

    chooseSaveDirBtn.addEventListener('click', chooseDownloadDirectory);
    clearSaveDirBtn.addEventListener('click', clearDownloadDirectory);
    restoreDownloadDirectory();

    function extFromUrl(url, fallback) {
        try {
            const path = new URL(url, location.href).pathname;
            const match = path.match(/\.([a-z0-9]+)$/i);
            return match ? match[1].toLowerCase() : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function cloudTaskOutputUrl(task) {
        const output = task && task.output;
        if (typeof output === 'string') return output;
        return output && (output.file_url || output.url || output.text_result || '');
    }

    function shortTaskId(taskId) {
        const value = String(taskId || '');
        return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value || '(无 ID)';
    }

    function formatCloudTime(value) {
        if (!value) return '';
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
    }

    function cloudTaskTimestamp(task) {
        const value = (task && (task.created_at || task.completed_at)) || null;
        if (value === null || value === undefined || value === '') return NaN;
        const timestamp = typeof value === 'number' ? value : new Date(value).getTime();
        if (!Number.isFinite(timestamp)) return NaN;
        return timestamp < 1e12 ? timestamp * 1000 : timestamp;
    }

    function cloudTaskDisplayTimestamp(task) {
        return task.created_at || task.completed_at;
    }

    function isCloudTaskInWindow(task, cutoff) {
        const timestamp = cloudTaskTimestamp(task);
        return Number.isFinite(timestamp) && timestamp >= cutoff;
    }

    function cloudTaskErrorMessage(task) {
        return task.message || (task.error && (task.error.message || task.error)) || '无详细原因';
    }

    async function fetchAllCloudTasks(token) {
        const pageSize = 100;
        const first = await requestJson({
            method: 'GET',
            url: `${API_BASE}${ENDPOINTS.tasks}?page=1&size=${pageSize}`,
            headers: { Authorization: `Bearer ${token}` }
        });
        if (first.status < 200 || first.status >= 300) {
            throw new Error(requestErrorMessage(first.status, first.data));
        }
        let items = Array.isArray(first.data.items) ? first.data.items : [];
        const total = Number(first.data.total);
        const pages = Math.min(5, Math.ceil(Number.isFinite(total) ? total / pageSize : 1));
        const cutoff = Date.now() - CLOUD_TASK_LINK_TTL;
        for (let page = 2; page <= pages; page += 1) {
            const next = await requestJson({
                method: 'GET',
                url: `${API_BASE}${ENDPOINTS.tasks}?page=${page}&size=${pageSize}`,
                headers: { Authorization: `Bearer ${token}` }
            });
            if (next.status < 200 || next.status >= 300) break;
            const nextItems = Array.isArray(next.data.items) ? next.data.items : [];
            items = items.concat(nextItems);
            if (nextItems.length && nextItems.every(task => !isCloudTaskInWindow(task, cutoff))) break;
        }
        const seen = new Set();
        cloudTasks = items.filter(task => {
            const id = task.task_id;
            if (!id || seen.has(id)) return false;
            if (cloudTaskDismissed.has(id)) return false;
            if (!isCloudTaskInWindow(task, cutoff)) return false;
            seen.add(id);
            return true;
        });
        cloudTaskTotal = cloudTasks.length;
    }

    function renderCloudTasks(error = '') {
        const counts = cloudTasks.reduce((acc, task) => {
            acc[task.status] = (acc[task.status] || 0) + 1;
            return acc;
        }, {});
        const statusLabels = { waiting: '等待', in_progress: '进行中', success: '成功', failure: '失败', cancelled: '已取消' };
        const pills = [
            `共 ${cloudTaskTotal} 条`,
            ...Object.keys(statusLabels).filter(key => counts[key]).map(key => `${statusLabels[key]} ${counts[key]}`)
        ];
        if (cloudTaskQuota) pills.push(`并发空闲 ${cloudTaskQuota.available}/${cloudTaskQuota.max_concurrency}`);
        cloudTaskCount.textContent = cloudTasks.length ? `${counts.success || 0} 个成功` : '';
        cloudTaskSummary.innerHTML = '';
        pills.forEach(text => {
            const pill = document.createElement('span');
            pill.className = 'zimg-cloud-pill';
            pill.textContent = text;
            cloudTaskSummary.appendChild(pill);
        });
        cloudTaskStrip.innerHTML = '';
        const importable = cloudTasks.filter(task => task.status === 'success' &&
            cloudTaskOutputUrl(task) && !libraryList.some(item => item.taskId === task.task_id) &&
            !cloudTaskLinkExpired(task)).length;
        importSuccessBtn.disabled = importingCloudTasks || importable === 0;
        if (error) {
            const empty = document.createElement('div');
            empty.className = 'zimg-library-empty';
            empty.textContent = error;
            cloudTaskStrip.appendChild(empty);
            return;
        }
        if (!cloudTasks.length) {
            const empty = document.createElement('div');
            empty.className = 'zimg-library-empty';
            empty.textContent = '暂无近 24 小时异步任务，或尚未刷新';
            cloudTaskStrip.appendChild(empty);
            return;
        }
        cloudTasks.forEach(task => {
            const card = document.createElement('div');
            card.className = 'zimg-cloud-task';
            card.title = [task.task_id, `状态：${statusLabels[task.status] || task.status}`, cloudTaskErrorMessage(task)]
                .filter(Boolean).join('\n');
            const id = document.createElement('div');
            id.className = 'zimg-cloud-id';
            id.textContent = shortTaskId(task.task_id);
            const status = document.createElement('div');
            status.className = `zimg-cloud-meta zimg-cloud-status-${task.status}`;
            status.textContent = statusLabels[task.status] || task.status || '未知';
            const time = document.createElement('div');
            time.className = 'zimg-cloud-meta';
            time.textContent = formatCloudTime(cloudTaskDisplayTimestamp(task));
            card.append(id, status, time);
            if (task.status === 'success' && cloudTaskOutputUrl(task)) {
                const imported = libraryList.some(item => item.taskId === task.task_id);
                const expired = imported ? false : cloudTaskLinkExpired(task);
                const actions = document.createElement('div');
                actions.className = 'zimg-cloud-actions';
                const previewBtn = document.createElement('button');
                previewBtn.type = 'button';
                previewBtn.className = 'zimg-cloud-action-preview';
                previewBtn.textContent = '👁 预览';
                previewBtn.addEventListener('click', event => {
                    event.stopPropagation();
                    previewCloudTask(task);
                });
                actions.appendChild(previewBtn);
                const importButton = document.createElement('button');
                importButton.type = 'button';
                importButton.className = 'zimg-cloud-import';
                if (imported) {
                    importButton.textContent = '✅ 已在库';
                    importButton.disabled = true;
                } else if (expired) {
                    importButton.textContent = '🕒 已过期';
                    importButton.disabled = true;
                } else {
                    importButton.textContent = '📥 导入';
                    importButton.disabled = importingCloudTasks;
                    importButton.addEventListener('click', async event => {
                        event.stopPropagation();
                        importButton.disabled = true;
                        importButton.textContent = '⏳ 导入中';
                        try {
                            await importCloudTask(task);
                            importButton.textContent = libraryList.some(item => item.taskId === task.task_id) ? '✅ 已导入' : '⚠️ 远程保留';
                        } catch (err) {
                            console.warn('[Gitee AI Generator] 云端任务导入失败', err);
                            if (/404|expired|过期/i.test(err.message)) {
                                cloudTaskExpired.add(task.task_id);
                                renderCloudTasks();
                                showStatus('loading', `🕒 该任务结果链接已过期，无法导入`);
                            } else {
                                importButton.textContent = '🔁 重试';
                                showStatus('error', `❌ 任务导入失败：${err.message}`);
                            }
                        } finally {
                            importButton.disabled = importingCloudTasks || libraryList.some(item => item.taskId === task.task_id);
                        }
                    });
                }
                actions.appendChild(importButton);
                const dismissBtn = document.createElement('button');
                dismissBtn.type = 'button';
                dismissBtn.className = 'zimg-cloud-action-dismiss';
                dismissBtn.textContent = '✕ 移除';
                dismissBtn.title = '从当前任务列表移除（不影响服务端）';
                dismissBtn.addEventListener('click', event => {
                    event.stopPropagation();
                    dismissCloudTask(task.task_id);
                });
                actions.appendChild(dismissBtn);
                card.appendChild(actions);
            } else if (task.status === 'waiting' || task.status === 'in_progress') {
                const actions = document.createElement('div');
                actions.className = 'zimg-cloud-actions';
                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'zimg-cloud-action-cancel';
                cancelBtn.textContent = '⛔ 取消任务';
                cancelBtn.addEventListener('click', async event => {
                    event.stopPropagation();
                    cancelBtn.disabled = true;
                    cancelBtn.textContent = '⏳ 取消中';
                    try {
                        await cancelCloudTask(task);
                        showStatus('success', `✅ 已取消任务 ${shortTaskId(task.task_id)}`);
                    } catch (err) {
                        cancelBtn.disabled = false;
                        cancelBtn.textContent = '⛔ 取消任务';
                        showStatus('error', `❌ 取消失败：${err.message}`);
                    }
                });
                actions.appendChild(cancelBtn);
                card.appendChild(actions);
            } else {
                const actions = document.createElement('div');
                actions.className = 'zimg-cloud-actions';
                const dismissBtn = document.createElement('button');
                dismissBtn.type = 'button';
                dismissBtn.className = 'zimg-cloud-action-dismiss';
                dismissBtn.textContent = '✕ 移除';
                dismissBtn.addEventListener('click', event => {
                    event.stopPropagation();
                    dismissCloudTask(task.task_id);
                });
                actions.appendChild(dismissBtn);
                card.appendChild(actions);
            }
            cloudTaskStrip.appendChild(card);
        });
    }

    async function importCloudTask(task) {
        const url = cloudTaskOutputUrl(task);
        if (!url) throw new Error('成功任务缺少结果地址');
        const kind = mediaKind(url, '');
        let blob;
        try {
            blob = await requestBlob(url);
        } catch (error) {
            if (/404/.test(error.message)) {
                cloudTaskExpired.add(task.task_id);
                throw new Error('结果签名链接已过期或失效（HTTP 404）');
            }
            throw error;
        }
        await saveLibraryItem({
            blob,
            sourceUrl: url,
            kind,
            ext: extFromUrl(url, { video: 'mp4', audio: 'mpeg', model: 'glb' }[kind] || 'bin')
        }, '(云端异步任务)', {
            mode: '',
            model: '',
            taskId: task.task_id
        });
    }

    async function loadCloudTasks({ silent = false } = {}) {
        const token = cleanToken(tokenInput.value);
        if (!token) {
            renderCloudTasks(silent ? '' : '请先填写或自动同步访问令牌');
            if (!silent) showStatus('error', '❌ 请先填写或获取访问令牌。');
            return;
        }
        refreshTasksBtn.disabled = true;
        if (!silent) renderCloudTasks('正在加载官方异步任务…');
        try {
            const quota = await requestJson({
                method: 'GET',
                url: API_BASE + ENDPOINTS.taskQuota,
                headers: { Authorization: `Bearer ${token}` }
            });
            cloudTaskQuota = quota.status >= 200 && quota.status < 300 ? quota.data : null;
            await fetchAllCloudTasks(token);
            resetCloudTaskExpired();
            renderCloudTasks();
            if (!silent) showStatus('success', `✅ 已加载 ${cloudTasks.length} 条云端任务`);
        } catch (error) {
            cloudTasks = [];
            renderCloudTasks(`云端任务读取失败：${error.message}`);
            if (!silent) showStatus('error', `❌ 云端任务读取失败：${error.message}`);
        } finally {
            refreshTasksBtn.disabled = false;
        }
    }

    async function importAllSuccessfulTasks() {
        if (importingCloudTasks) return;
        const tasks = cloudTasks.filter(task => task.status === 'success' &&
            cloudTaskOutputUrl(task) && !libraryList.some(item => item.taskId === task.task_id) &&
            !cloudTaskLinkExpired(task));
        const skippedExpired = cloudTasks.filter(task => task.status === 'success' &&
            cloudTaskOutputUrl(task) && !libraryList.some(item => item.taskId === task.task_id) &&
            cloudTaskLinkExpired(task)).length;
        if (!tasks.length) return;
        importingCloudTasks = true;
        importSuccessBtn.disabled = true;
        let completed = 0;
        for (const [index, task] of tasks.entries()) {
            importSuccessBtn.textContent = `⏳ 导入中 ${index + 1}/${tasks.length}`;
            try {
                await importCloudTask(task);
                completed += 1;
            } catch (error) {
                console.warn('[Gitee AI Generator] 批量导入跳过失败任务', task.task_id, error);
            }
        }
        importingCloudTasks = false;
        importSuccessBtn.textContent = '📥 导入全部成功';
        renderCloudTasks();
        showStatus(completed === tasks.length ? 'success' : 'loading',
            completed === tasks.length
                ? `✅ 已导入 ${completed} 个云端产物`
                : `⚠️ 已导入 ${completed}/${tasks.length} 个${skippedExpired ? `；${skippedExpired} 个链接已过期` : ''}`);
        setTimeout(() => { if (!isGenerating) statusBox.style.display = 'none'; }, 2500);
    }

    refreshTasksBtn.addEventListener('click', () => loadCloudTasks());

    function cloudTaskLinkExpired(task) {
        if (!task) return false;
        if (cloudTaskExpired.has(task.task_id)) return true;
        const ts = Number(task.completed_at || task.created_at || 0);
        return ts > 0 && Date.now() - ts > CLOUD_TASK_LINK_TTL;
    }

    function resetCloudTaskExpired() {
        cloudTaskExpired = new Set();
    }
    importSuccessBtn.addEventListener('click', importAllSuccessfulTasks);

    async function previewCloudTask(task) {
        const url = cloudTaskOutputUrl(task);
        if (!url) {
            showStatus('error', '❌ 该任务没有可预览的结果地址');
            return;
        }
        try {
            const kind = mediaKind(url, '');
            const ext = extFromUrl(url, { video: 'mp4', audio: 'mpeg', model: 'glb' }[kind] || 'bin');
            const result = {
                kind,
                ext,
                sourceUrl: url,
                filename: `gitee-ai-cloud-${kind}-${task.task_id}.${ext}`
            };
            const blob = await requestBlob(url);
            releaseCurrentObjectUrl();
            const objectUrl = URL.createObjectURL(blob);
            result.url = objectUrl;
            showResult(result, '(云端异步任务预览)');
            currentObjectUrl = objectUrl;
            showStatus('loading', '👁 正在预览云端任务结果（未保存到本地库）');
            setTimeout(() => { if (!isGenerating) statusBox.style.display = 'none'; }, 2000);
        } catch (error) {
            if (/404|expired|过期/i.test(error.message)) {
                cloudTaskExpired.add(task.task_id);
                renderCloudTasks();
                showStatus('loading', '🕒 该任务结果链接已过期，无法预览');
            } else {
                showStatus('error', `❌ 预览失败：${error.message}`);
            }
        }
    }

    async function cancelCloudTask(task) {
        const token = cleanToken(tokenInput.value);
        if (!token) throw new Error('请先填写或同步访问令牌');
        const cancelUrl = (task.urls && task.urls.cancel) || `${API_BASE}/v1/task/${encodeURIComponent(task.task_id)}/cancel`;
        const response = await requestJson({
            method: 'POST',
            url: cancelUrl,
            headers: { Authorization: `Bearer ${token}` }
        });
        if (response.status < 200 || response.status >= 300) {
            throw new Error(requestErrorMessage(response.status, response.data));
        }
        cloudTaskDismissed.add(task.task_id);
        persistDismissedCloudTasks();
        await loadCloudTasks({ silent: true });
    }

    function dismissCloudTask(taskId) {
        if (!taskId) return;
        cloudTaskDismissed.add(taskId);
        persistDismissedCloudTasks();
        cloudTasks = cloudTasks.filter(t => t.task_id !== taskId);
        renderCloudTasks();
    }

    function hideResultMedia() {
        [previewImg, previewVideo, previewAudio, previewFileCard, previewText].forEach(node => {
            node.style.display = 'none';
        });
        previewImg.removeAttribute('src');
        previewVideo.removeAttribute('src');
        previewAudio.removeAttribute('src');
        previewText.textContent = '';
    }

    function showResult(result, prompt) {
        releaseCurrentObjectUrl();
        currentResult = result;
        hideResultMedia();
        if (result.kind === 'image') {
            previewImg.src = result.url;
            previewImg.style.display = '';
        } else if (result.kind === 'video') {
            previewVideo.src = result.url;
            previewVideo.style.display = '';
        } else if (result.kind === 'audio') {
            previewAudio.src = result.url;
            previewAudio.style.display = '';
        } else if (result.kind === 'text') {
            previewText.textContent = result.text;
            previewText.style.display = '';
        } else {
            fileKindText.textContent = result.kind === 'model' ? '🧊 3D 模型' : '📄 生成文件';
            fileNameText.textContent = result.filename || `${result.ext || 'bin'} 文件`;
            previewFileCard.style.display = 'flex';
        }
        copyLinkBtn.innerText = result.kind === 'text' ? '📋 复制文本' : '📋 复制链接';
        resultBox.style.display = 'flex';
    }

    function openModal() {
        overlay.style.display = 'flex';
        switchMode(currentMode);
        refreshToken(false);
        initLibrary();
        loadCloudTasks({ silent: true });
        updateQuotaDisplay();
    }
    function closeModal() {
        overlay.style.display = 'none';
    }

    fab.addEventListener('click', () => {
        if (hasMoved) return;
        openModal();
    });

    document.getElementById('zimg-btn-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });

    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (agentOverlay.style.display === 'flex') {
            closeAgentDialog();
        } else if (consoleOverlay.style.display === 'flex') {
            closeConsole();
        } else if (overlay.style.display === 'flex') {
            closeModal();
        }
    });

    promptInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            doGenerate();
        }
    });

    document.getElementById('zimg-btn-toggle-pwd').addEventListener('click', () => {
        tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password';
    });

    function showStatus(type, msg) {
        statusBox.className = `zimg-status ${type}`;
        if (type === 'loading') {
            statusBox.innerHTML = `<div class="zimg-spinner"></div><div>${msg}</div>`;
        } else {
            statusBox.innerHTML = msg;
        }
        statusBox.style.display = 'flex';
    }

    function refreshToken(force = true) {
        const token = autoDetectToken();
        const quota = extractLiveQuotaFromPage(force);
        if (token) {
            tokenInput.value = token;
            updateQuotaDisplay(quota);
            if (force) {
                showStatus('success', '✅ 已自动获取访问令牌');
                setTimeout(() => { if (!isGenerating) statusBox.style.display = 'none'; }, 2500);
            }
        } else {
            updateQuotaDisplay(quota);
            if (force) {
                showStatus('error', '⚠️ 未能自动获取访问令牌（非 Gitee 页面无法自动探测），请手动粘贴，或到 https://ai.gitee.com/serverless-api 创建后粘贴');
            }
        }
    }
    document.getElementById('zimg-btn-refresh-token').addEventListener('click', () => refreshToken(true));

    // ===================== Agent 提示词导出 =====================
    // 生成一份 Markdown 接口调用指南（模型清单从 MODEL_REGISTRY 动态读取，与面板保持一致），
    // 保存到项目后，Codex / Claude Code 等 Agent 软件即可按文档直接调用 Gitee AI 接口
    const agentTextEl = document.getElementById('zimg-agent-text');

    function listModels(mode) {
        return MODEL_REGISTRY[mode].models
            .map(m => '`' + m.value + '`')
            .join('、');
    }

    function buildAgentPrompt() {
        const tokenLine = '<在此填入你的 Gitee AI 访问令牌>';
        const now = new Date();
        const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        const lines = [
            '# Gitee AI Serverless API — Agent 调用指南',
            '',
            '> 本文档面向 AI 编程助手（Codex、Claude Code、Cursor 等）。你（Agent）可以在任务需要时，',
            '> 按下述约定直接通过 HTTP 调用这些接口完成图片 / 视频 / 语音 / 3D / 文本生成任务。',
            '> 文档生成日期：' + dateStr,
            '',
            '## 0. 基础约定',
            '',
            '- Base URL：`https://ai.gitee.com`',
            '- 认证方式：所有请求携带请求头 `Authorization: Bearer <TOKEN>`',
            '- TOKEN：`' + tokenLine + '`',
            '- 令牌获取：https://ai.gitee.com/serverless-api （登录后创建，形如 36-44 位大写字母数字）',
            '- ⚠️ 上方 TOKEN 永远是占位符；向使用者索要令牌后仅在当前会话使用，禁止写入文件或提交仓库',
            '- 标注 🆓 的模型为当前免费模型，优先使用；其余模型按量计费，调用前先向使用者确认',
            '- 示例约定：下文所有 curl 中的 `$TOKEN` 即上方令牌。执行前先 `export TOKEN=<令牌>`，或逐条替换，切勿原样执行（否则认证头为空，必然 401）',
            '- 端点纪律：仅使用本文档列出的端点与参数，不要凭记忆猜测未列出的接口；若实际响应与本文档不符，以响应为准并向使用者报告',
            '- multipart 上传（curl 的 `-F`、fetch/requests 的 form-data）不要手工设置 `Content-Type`，由 HTTP 客户端自动生成 boundary，否则上传必失败',
            '- 错误响应统一为 JSON，错误信息在 `message` 或 `error_message` 字段',
            '',
            '## 1. 同步接口（一次请求直接返回结果）',
            '',
            '### 1.1 文本对话（🆓 全部免费）— `POST /v1/chat/completions`',
            '',
            'OpenAI Chat Completions 兼容格式，支持多轮 messages 与 stream 流式返回；也可直接用 OpenAI SDK（`base_url="https://ai.gitee.com/v1"`、`api_key=<TOKEN>`）。',
            '',
            '免费模型：' + listModels('chat'),
            '',
            '```bash',
            'curl https://ai.gitee.com/v1/chat/completions \\',
            '  -H "Authorization: Bearer $TOKEN" \\',
            '  -H "Content-Type: application/json" \\',
            '  -d \'{',
            '    "model": "Qwen3-8B",',
            '    "messages": [',
            '      {"role": "system", "content": "你是一个简洁的中文助手"},',
            '      {"role": "user", "content": "用两句话介绍你自己"}',
            '    ],',
            '    "temperature": 0.7,',
            '    "max_tokens": 1024',
            '  }\'',
            '```',
            '',
            '可调参数：`temperature`(0-2)、`top_p`、`max_tokens`、`frequency_penalty`、`presence_penalty`、`top_k`(OpenAI SDK 经 `extra_body` 传入)、`stream`(SSE, `data: {...}` 增量, 以 `data: [DONE]` 结束)。',
            '',
            '成功响应示例（截选）：',
            '',
            '```json',
            '{"choices":[{"message":{"role":"assistant","content":"回复内容"}}],"usage":{"total_tokens":123}}',
            '```',
            '',
            '回复文本取 `choices[0].message.content`；DeepSeek-R1 蒸馏模型的思考过程在 `choices[0].message.reasoning_content`；流式时增量在 `choices[0].delta.content`。',
            '',
            '### 1.2 文生图 — `POST /v1/images/generations`',
            '',
            '模型：' + listModels('image'),
            '',
            '```bash',
            'curl https://ai.gitee.com/v1/images/generations \\',
            '  -H "Authorization: Bearer $TOKEN" \\',
            '  -H "Content-Type: application/json" \\',
            '  -d \'{',
            '    "model": "z-image-turbo",',
            '    "prompt": "一只戴宇航头盔的柴犬，摄影质感",',
            '    "size": "1024x1024",',
            '    "num_inference_steps": 9,',
            '    "response_format": "url"',
            '  }\'',
            '```',
            '',
            '可调参数：`size`(常用 `1024x1024` / `1536x864`)、`width`/`height`、`num_inference_steps`、`negative_prompt`、`guidance_scale`、`seed`、`num_images_per_prompt`、`response_format`(`url` 或 `b64_json`)。分辨率和枚举以所选模型元数据为准；个别模型可能提供 4K 档。',
            '响应：`data[0].url` 或 `data[0].b64_json`；`b64_json` 数据量大，除非要离线保存，优先用 `url`。',
            '',
            '### 1.3 语音识别（🆓 全部免费）— `POST /v1/audio/transcriptions`',
            '',
            'multipart/form-data 上传音频转文字。模型：' + listModels('asr'),
            '',
            '```bash',
            'curl https://ai.gitee.com/v1/audio/transcriptions \\',
            '  -H "Authorization: Bearer $TOKEN" \\',
            '  -F file=@audio.mp3 \\',
            '  -F model=SenseVoiceSmall \\',
            '  -F language=zh        # 可选，留空自动检测',
            '```',
            '',
            '响应：`{"text": "识别出的文字"}`。支持 mp3 / wav / m4a 等常见格式。',
            '',
            '## 2. 异步接口（提交任务 → 轮询结果）',
            '',
            '统一流程：',
            '',
            '1. POST 提交任务，成功响应示例（`task_id` 为 32 位大写字母数字串；`urls` 内直接给出轮询与取消地址，可直接使用）：',
            '',
            '```json',
            '{"task_id": "SBOMLX0YXU8SVJQXY6CNWVJ7OJAND5TK", "status": "waiting", "created_at": 1787474128023,',
            ' "urls": {"get": "https://ai.gitee.com/v1/task/SBOM...", "cancel": "https://ai.gitee.com/v1/task/SBOM.../cancel"}}',
            '```',
            '',
            '2. 携带同一认证头轮询任务状态（每 4 秒一次，最长 15 分钟）：',
            '',
            '```bash',
            'curl https://ai.gitee.com/v1/task/$TASK_ID -H "Authorization: Bearer $TOKEN"',
            '```',
            '',
            '3. 响应中的 `status` 字段状态机：',
            '   - `success` → 终态成功。完整响应示例：`{"task_id":"...","status":"success","output":{"file_url":"https://gitee-ai.su.bcebos.com/..."},"price":0.0,"currency":"CNY","urls":{...}}`，结果取 `output.file_url`（或 `output.url`）；',
            '   - `failure` / `cancelled` → 终态失败或已取消，原因在 `message` 字段，据此修正参数后可重新提交一次；',
            '   - 其它取值（如 `waiting`）→ 仍在排队 / 处理中，继续轮询，不要提前放弃。',
            '',
            '4. 需要中止时：优先使用提交响应里的 `urls.cancel`，否则使用 `POST /v1/task/{task_id}/cancel`。',
            '',
            '### 2.0 云端任务列表与并发配额',
            '',
            '任务列表只保留近 7 天记录，按创建时间倒序；成功产物签名链接有效期约 1 天。需要长期保留时立即下载：',
            '',
            '```bash',
            '# 分页读取官方异步任务；返回 {"total":25,"items":[...]}',
            'curl "https://ai.gitee.com/v1/tasks?page=1&size=100" -H "Authorization: Bearer $TOKEN"',
            '',
            '# 当前可用的异步并发槽位',
            'curl https://ai.gitee.com/v1/tasks/available-quota -H "Authorization: Bearer $TOKEN"',
            '```',
            '',
            '`InferenceTask.items[*]` 常用字段：`task_id`、`status`(`waiting`/`in_progress`/`success`/`failure`/`cancelled`)、`created_at`、`started_at`、`completed_at`、`output`、`price`、`currency`、`urls.get`、`urls.cancel`。列表响应不含提交时的提示词和模型名；导入本地库时应按 `task_id` 去重，并优先保存文件内容而不是仅保存签名 URL。',
            '',
            '### 2.1 文生视频 — `POST /v1/async/videos/generations`',
            '',
            '模型：' + listModels('textVideo'),
            '',
            'JSON 参数：`model`、`prompt`、`num_frames`(如 81)、`num_inference_steps`、`negative_prompt`、`seed`、`aspect_ratio`("16:9"/"9:16"/"1:1")、`fps`(16/24)。文生视频通过画面比例控制构图，最终分辨率由模型决定。',
            '',
            '### 2.2 图生视频 — `POST /v1/async/videos/image-to-video`',
            '',
            '模型：' + listModels('imageVideo'),
            '',
            'multipart 参数：`model`、`image`(图片文件)、`prompt`、`num_frames`、`width`、`height`、`num_inference_steps`、`fps`、`guidance_scale`、`seed`、`negative_prompt`。常见宽度/高度上限为 2048；帧数、步数和 fps 以模型元数据为准。',
            '',
            '### 2.3 语音合成（🆓 免费）— `POST /v1/async/audio/speech`',
            '',
            '模型：' + listModels('speech'),
            '',
            '```bash',
            'curl https://ai.gitee.com/v1/async/audio/speech \\',
            '  -H "Authorization: Bearer $TOKEN" \\',
            '  -H "Content-Type: application/json" \\',
            '  -d \'{',
            '    "model": "Spark-TTS-0.5B",',
            '    "inputs": "你好，这是一段测试语音。",',
            '    "gender": "female",',
            '    "pitch": 3,',
            '    "speed": 3,',
            '    "response_format": "url"',
            '  }\'',
            '```',
            '',
            '`gender` 为 `female` / `male`，`pitch` / `speed` 取 1-5。',
            '',
            '### 2.4 图片转 3D — `POST /v1/async/image-to-3d`',
            '',
            '模型：' + listModels('threeD'),
            '',
            'multipart 参数：`model`、`image`、`seed`、`file_format`(`glb`/`stl`)。',
            'Hunyuan3D-2 追加：`type`、`num_inference_steps`(2-50)、`octree_resolution`(16/64/128/256/400)、`guidance_scale`、`texture`(`true`/`false`)、`foreground_detection`、`mc_resolution`(默认 512)、`face_count`(默认 80000)。',
            '',
            '## 3. Agent 行为约定',
            '',
            '1. **免费优先**：文本、语音识别、语音合成优先选 🆓 模型；图像 / 视频 / 3D 为付费模型，调用前先向使用者确认。',
            '2. **轮询纪律**：异步任务每 4 秒 GET 一次任务状态，最多 15 分钟；不要小于 1 秒的频率轰炸接口。',
            '3. **错误处理**：HTTP 401 → 令牌无效，停止重试并提示使用者；429 / 5xx → 指数退避重试（最多 3 次）；其余 4xx 按 message 修正参数。',
            '4. **产物落地**：结果 URL 直接交给使用者，或下载保存到项目 `output/` 目录；`file_url` 为百度云 BOS 签名链接，有效期约 1 天，需长期保留请及时下载。',
            '5. **勿泄露令牌**：不要把 TOKEN 打印到日志、注释或对外输出中。',
            '',
            '## 4. 端点速查表',
            '',
            '| 功能 | 方法与路径 | 类型 | 费用 |',
            '|---|---|---|---|',
            '| 文本对话 | `POST /v1/chat/completions` | 同步 | 🆓 免费 |',
            '| 文生图 | `POST /v1/images/generations` | 同步 | 付费 |',
            '| 语音识别 | `POST /v1/audio/transcriptions` | 同步 | 🆓 免费 |',
            '| 文生视频 | `POST /v1/async/videos/generations` | 异步 | 付费 |',
            '| 图生视频 | `POST /v1/async/videos/image-to-video` | 异步 | 付费 |',
            '| 语音合成 | `POST /v1/async/audio/speech` | 异步 | 🆓 免费 |',
            '| 图片转 3D | `POST /v1/async/image-to-3d` | 异步 | 付费 |',
            '| 文生图（大图异步） | `POST /v1/async/images/generations` | 异步 | 付费 |',
            '| 任务列表 | `GET /v1/tasks?page=1&size=100` | — | — |',
            '| 并发配额 | `GET /v1/tasks/available-quota` | — | — |',
            '| 任务轮询 | `GET /v1/task/{task_id}` | — | — |',
            '| 取消任务 | `POST /v1/task/{task_id}/cancel` | — | — |',
            '',
            '另有一些平台已知端点（人脸迁移 `/v1/images/face-migration`、文转 3D `/v1/async/text-to-3d`、文档解析 `/v1/async/documents/parse` 等），本文档未展开；使用前先向使用者确认需求与费用。',
        ];
        return lines.join('\n');
    }

    function renderAgentPrompt() {
        agentTextEl.value = buildAgentPrompt();
    }

    document.getElementById('zimg-agent-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(agentTextEl.value).then(() => {
            showStatus('success', '✅ Agent 提示词已复制到剪贴板');
            setTimeout(() => { if (!isGenerating) statusBox.style.display = 'none'; }, 2000);
        }).catch(err => {
            showStatus('error', '❌ 复制失败：' + err);
        });
    });

    document.getElementById('zimg-agent-download').addEventListener('click', () => {
        const blob = new Blob([agentTextEl.value], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'gitee-ai-agents.md';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    function openAgentDialog() {
        renderAgentPrompt();
        agentOverlay.style.display = 'flex';
    }
    function closeAgentDialog() {
        agentOverlay.style.display = 'none';
    }

    document.getElementById('zimg-btn-agent-prompt').addEventListener('click', openAgentDialog);
    document.getElementById('zimg-agent-close').addEventListener('click', closeAgentDialog);
    agentOverlay.addEventListener('click', (e) => {
        if (e.target === agentOverlay) closeAgentDialog();
    });

    document.getElementById('zimg-btn-console').addEventListener('click', () => {
        openConsole();
    });
    document.getElementById('zimg-console-close').addEventListener('click', closeConsole);
    consoleOverlay.addEventListener('click', (e) => {
        if (e.target === consoleOverlay) closeConsole();
    });
    document.getElementById('zimg-console-endpoint').addEventListener('change', () => {
        fillConsoleOperations();
        renderConsoleForm();
    });
    document.getElementById('zimg-console-operation').addEventListener('change', renderConsoleForm);
    document.getElementById('zimg-console-refresh').addEventListener('click', async () => {
        const state = document.getElementById('zimg-console-state');
        try {
            state.textContent = '正在拉取官方 OpenAPI…';
            await refreshOpenApiConsole();
        } catch (error) {
            state.textContent = `刷新失败：${error.message}`;
        }
    });
    document.getElementById('zimg-console-query').addEventListener('click', updateConsoleSource);
    document.getElementById('zimg-console-send').addEventListener('click', runConsoleRequest);

    async function controlConsoleTask(action) {
        const taskId = document.getElementById('zimg-console-task-id').value.trim();
        const state = document.getElementById('zimg-console-state');
        if (!taskId) {
            state.textContent = '请先填写任务 ID';
            return;
        }
        try {
            state.textContent = '任务请求中…';
            const response = await requestJson({
                method: action === 'cancel' ? 'POST' : 'GET',
                url: `${API_BASE}/v1/task/${encodeURIComponent(taskId)}${action === 'status' ? '/status' : action === 'cancel' ? '/cancel' : ''}`,
                headers: { Authorization: `Bearer ${validateToken()}` }
            });
            if (response.status < 200 || response.status >= 300) throw new Error(requestErrorMessage(response.status, response.data, response.data && response.data.raw));
            document.getElementById('zimg-console-response').value = JSON.stringify(response.data, null, 2);
            state.textContent = `任务 ${action} 成功`;
        } catch (error) {
            state.textContent = `任务 ${action} 失败：${error.message}`;
        }
    }
    document.getElementById('zimg-console-task-get').addEventListener('click', () => controlConsoleTask('get'));
    document.getElementById('zimg-console-task-status').addEventListener('click', () => controlConsoleTask('status'));
    document.getElementById('zimg-console-task-cancel').addEventListener('click', () => controlConsoleTask('cancel'));

    document.querySelectorAll('.zimg-tag').forEach(tag => {
        tag.addEventListener('click', () => {
            const modes = (tag.getAttribute('data-modes') || 'image').split(',');
            if (!modes.includes(currentMode)) return;
            promptInput.value = tag.getAttribute('data-p');
            promptInput.focus();
        });
    });

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function makeRequest(options) {
        return new Promise((resolve, reject) => {
            safeGM.xmlhttpRequest({
                timeout: 120000,
                ...options,
                onload: resolve,
                onerror: reject,
                ontimeout: () => reject(new Error('请求超时'))
            });
        });
    }

    async function requestJson(options) {
        const response = await makeRequest(options);
        let data = null;
        try {
            data = JSON.parse(response.responseText);
        } catch (_) {
            data = { raw: response.responseText };
        }
        return { status: response.status, data };
    }

    // ===================== 全参数控制台 =====================
    const CONTROLS_FALLBACK_URL = 'https://raw.githubusercontent.com/haremank/gitee-ai-agents-guide/main/assets/gitee-serverless-controls.compact.json';
    const OPEN_API_ALLOWED_TAGS = new Set([
        '文档处理', '图像识别', '视频生成', '3D 生成', '自动语音识别', '语音合成',
        '音乐生成', '图像生成', '异步任务', '文本生成', '应用场景接口', '特征抽取',
        '风控识别', '搜索', 'API 流水线'
    ]);
    let consoleEndpoints = [];
    let controlsSchema = null;
    let openapiSchema = null;

    function parseJsonSafe(text, fallback) {
        try { return JSON.parse(text); } catch (_) { return fallback; }
    }

    async function loadControlsSchema() {
        if (controlsSchema) return controlsSchema;
        let text = '';
        try {
            if (typeof GM_getResourceText !== 'undefined') text = GM_getResourceText('GITEE_CONTROLS') || '';
        } catch (_) {}
        if (!text) {
            const response = await makeRequest({ method: 'GET', url: CONTROLS_FALLBACK_URL, timeout: 20000 });
            if (response.status < 200 || response.status >= 300) throw new Error(`参数元数据加载失败：HTTP ${response.status}`);
            text = response.responseText;
        }
        controlsSchema = parseJsonSafe(text, null);
        if (!controlsSchema || !Array.isArray(controlsSchema.e)) throw new Error('参数元数据格式无效');
        consoleEndpoints = controlsSchema.e.map(endpoint => ({
            ...endpoint,
            method: 'POST',
            origin: 'operations'
        })).sort((a, b) => D(a).localeCompare(D(b)));
        return controlsSchema;
    }

    function D(index) {
        return controlsSchema && controlsSchema.d ? String(controlsSchema.d[index] ?? '') : '';
    }

    function decodeRef(index, fallback) {
        return index === undefined || index === null || index < 0 ? fallback : parseJsonSafe(D(index), fallback);
    }

    function consoleEndpointLabel(endpoint) {
        const prefix = endpoint.origin === 'openapi' ? `[${endpoint.method}] ` : '[模型操作] ';
        return prefix + '/' + D(endpoint.p);
    }

    function fillConsoleEndpoints() {
        const select = document.getElementById('zimg-console-endpoint');
        select.innerHTML = '';
        consoleEndpoints.forEach((endpoint, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = consoleEndpointLabel(endpoint);
            select.appendChild(option);
        });
    }

    function selectedConsoleEndpoint() {
        return consoleEndpoints[Number(document.getElementById('zimg-console-endpoint').value || 0)];
    }

    function fillConsoleOperations() {
        const endpoint = selectedConsoleEndpoint();
        const select = document.getElementById('zimg-console-operation');
        select.innerHTML = '';
        (endpoint.o || []).forEach((operation, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            const model = D(operation.model) || '通用';
            const price = operation.free ? '免费' : `价格 ${operation.price ?? '未知'}`;
            option.textContent = `${model} · ${operation.name || operation.id || '默认'} · ${price}`;
            select.appendChild(option);
        });
    }

    function variantFor(parameter, operationIndex) {
        const raw = parameter.v && parameter.v[operationIndex];
        if (!raw) return null;
        return {
            required: raw[0] === 1,
            default: raw[1] < 0 ? undefined : parseJsonSafe(D(raw[1]), D(raw[1])),
            range: raw[2] < 0 ? null : parseJsonSafe(D(raw[2]), null),
            options: raw[3] < 0 ? [] : parseJsonSafe(D(raw[3]), []),
            description: raw[4] < 0 ? undefined : D(raw[4])
        };
    }

    function consoleInputId(index) {
        return `zimg-console-param-${index}`;
    }

    function renderConsoleForm() {
        const endpoint = selectedConsoleEndpoint();
        const operationIndex = Number(document.getElementById('zimg-console-operation').value || 0);
        const operation = (endpoint.o || [])[operationIndex];
        const container = document.getElementById('zimg-console-form');
        const parameterType = parameter => D(parameter.t);
        container.innerHTML = '';
        (endpoint.r || []).forEach((parameter, index) => {
            const name = D(parameter.k);
            const variant = variantFor(parameter, operationIndex);
            const defaults = decodeRef(parameter.f, []);
            const baseRanges = decodeRef(parameter.r, []);
            const baseOptions = decodeRef(parameter.o, []);
            const range = variant && variant.range ? variant.range : (baseRanges[0] || {});
            const options = variant && Array.isArray(variant.options) && variant.options.length ? variant.options : baseOptions;
            const controls = decodeRef(parameter.c, []);
            const type = parameterType(parameter);
            const control = controls.find(item => ['select', 'slider', 'file', 'boolean', 'array', 'multimodal', 'string-array', 'seed-numbers'].includes(item)) || (type === 'boolean' ? 'boolean' : type === 'number' || type === 'integer' ? 'number' : 'text');
            let value = variant && variant.default !== undefined ? variant.default : defaults[0];
            if ((value === undefined || value === null) && options.length) value = options[0];

            const field = document.createElement('div');
            field.className = 'zimg-field zimg-console-field' + (['array', 'multimodal', 'string-array', 'seed-numbers'].includes(control) ? ' zimg-console-wide' : '');
            const requiredMark = (parameter.q === 1 || (variant && variant.required)) ? ' <b style="color:#dc2626;">*</b>' : '';
            field.innerHTML = `<div class="zimg-label-row"><span class="zimg-label">${name}${requiredMark}</span><span class="zimg-label-sub">${D(parameter.l)} · ${D(parameter.t)}</span></div>`;
            const id = consoleInputId(index);
            let input;
            let display = null;
            if (control === 'boolean') {
                input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = value === true || value === 'True' || value === 'true';
                input.className = 'zimg-input';
            } else if (control === 'select') {
                input = document.createElement('select');
                input.className = 'zimg-input';
                options.forEach(option => {
                    const item = document.createElement('option');
                    item.value = String(option);
                    item.textContent = String(option);
                    input.appendChild(item);
                });
                if ([...input.options].some(item => item.value === String(value))) input.value = String(value);
            } else if (control === 'slider') {
                input = document.createElement('input');
                input.type = 'range';
                input.min = range.min ?? 0;
                input.max = range.max ?? 100;
                input.step = range.step || 1;
                input.value = Number(value ?? range.min ?? 0);
                display = document.createElement('div');
                display.className = 'zimg-label-sub';
                display.textContent = `${input.value}（${input.min} - ${input.max}）`;
                input.addEventListener('input', () => {
                    display.textContent = `${input.value}（${input.min} - ${input.max}）`;
                    updateConsolePreview();
                });
                field.appendChild(input);
                field.appendChild(display);
            } else if (control === 'file') {
                input = document.createElement('input');
                input.type = 'file';
                input.className = 'zimg-file-input';
            } else if (['array', 'multimodal', 'string-array', 'seed-numbers'].includes(control)) {
                input = document.createElement('textarea');
                input.rows = 3;
                input.placeholder = 'JSON 数组，例如 [{"url":"https://example.com/a.png"}]';
                input.value = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
                input.className = 'zimg-input';
            } else {
                input = document.createElement('input');
                input.type = type === 'integer' || type === 'number' ? 'number' : 'text';
                input.value = value === undefined || value === null ? '' : String(value);
                input.step = range.step || (type === 'integer' ? '1' : 'any');
                if (range.min !== undefined && range.min !== null) input.min = range.min;
                if (range.max !== undefined && range.max !== null) input.max = range.max;
                input.className = 'zimg-input';
            }
            input.id = id;
            if (control !== 'slider') input.addEventListener('change', updateConsolePreview);
            if (!display.parentNode || display.parentNode !== field) field.appendChild(input);
            const help = variant && variant.description !== undefined ? variant.description : D(parameter.d).split('\n')[0];
            if (help) {
                const note = document.createElement('div');
                note.className = 'zimg-model-note';
                note.textContent = help;
                field.appendChild(note);
            }
            container.appendChild(field);
        });

        const paidRow = document.getElementById('zimg-console-paid-row');
        paidRow.style.display = operation && operation.free ? 'none' : '';
        document.getElementById('zimg-console-paid-confirm').checked = false;
        updateConsoleSource();
        updateConsolePreview();
    }

    function updateConsoleSource() {
        const endpoint = selectedConsoleEndpoint();
        const operationIndex = Number(document.getElementById('zimg-console-operation').value || 0);
        const operation = (endpoint.o || [])[operationIndex];
        const model = D(operation && operation.model);
            const lines = [
                `路径：${endpoint.method || 'POST'} /${D(endpoint.p)}`,
            model ? `模型：${model}` : '模型：通用',
            '',
            '标准查询方法：',
            'curl https://ai.gitee.com/v1/models -H "Authorization: Bearer $TOKEN"',
            'curl https://ai.gitee.com/v1/json -H "Authorization: Bearer $TOKEN"',
            model ? `curl "https://ai.gitee.com/api/pay/service/operations?service_ident=${encodeURIComponent(model)}" -H "Authorization: Bearer $TOKEN"` : ''
        ].filter(Boolean);
        document.getElementById('zimg-console-source').textContent = lines.join('\n');
    }

    function collectConsoleValues() {
        const endpoint = selectedConsoleEndpoint();
        const operationIndex = Number(document.getElementById('zimg-console-operation').value || 0);
        const values = [];
        (endpoint.r || []).forEach((parameter, index) => {
            const input = document.getElementById(consoleInputId(index));
            if (!input) return;
            const controls = decodeRef(parameter.c, []);
            const type = D(parameter.t);
            const kind = controls[0] || type;
            let value;
            if (kind === 'file') {
                value = input.files && input.files[0] ? input.files[0] : undefined;
            } else if (kind === 'boolean') {
                value = input.checked;
            } else if (['array', 'multimodal', 'string-array', 'seed-numbers'].includes(kind)) {
                const parsed = parseJsonSafe(input.value.trim(), undefined);
                value = parsed !== undefined ? parsed : input.value.trim().split(/[\n,]/).map(item => item.trim()).filter(Boolean);
            } else if (type === 'integer' || type === 'number') {
                value = optionalNumber(input.value);
            } else {
                value = input.value.trim();
            }
            const variant = variantFor(parameter, operationIndex);
            if (value === undefined || value === null || value === '') {
                if (parameter.q === 1 || (variant && variant.required)) {
                    throw new Error(`必填参数缺失：${D(parameter.k)}`);
                }
                return;
            }
            const range = variant && variant.range ? variant.range : decodeRef(parameter.r, [])[0];
            if ((type === 'number' || type === 'integer') && range) {
                if (range.min !== undefined && range.min !== null && value < range.min) throw new Error(`${D(parameter.k)} 不能小于 ${range.min}`);
                if (range.max !== undefined && range.max !== null && value > range.max) throw new Error(`${D(parameter.k)} 不能大于 ${range.max}`);
            }
            const options = variant && variant.options && variant.options.length ? variant.options : decodeRef(parameter.o, []);
            if (controls.includes('select') && options.length && !options.map(String).includes(String(value))) {
                throw new Error(`${D(parameter.k)} 只能选择：${options.join(', ')}`);
            }
            values.push({ parameter, value });
        });
        return values;
    }

    function assignPath(target, path, value) {
        const parts = path.split('.');
        let node = target;
        parts.forEach((part, index) => {
            if (index === parts.length - 1) node[part] = value;
            else {
                node[part] = node[part] || {};
                node = node[part];
            }
        });
    }

    function buildConsoleRequest() {
        const endpoint = selectedConsoleEndpoint();
        const requestMethod = endpoint.method || 'POST';
        const values = collectConsoleValues();
        const url = new URL(API_BASE + '/' + D(endpoint.p));
        const headers = { Authorization: `Bearer ${validateToken()}`, 'X-Failover-Enabled': 'true' };
        const query = new URLSearchParams();
        const json = {};
        const form = new FormData();
        const useForm = values.some(({ parameter, value }) => D(parameter.l) === 'form' || value instanceof File);

        values.forEach(({ parameter, value }) => {
            const name = D(parameter.k);
            const location = D(parameter.l);
            if (location === 'head') {
                headers[name] = String(value);
            } else if (location === 'query' || (!useForm && ['GET', 'DELETE'].includes(requestMethod) && location !== 'head')) {
                query.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
            } else if (location === 'form' || value instanceof File) {
                form.append(name, value instanceof File ? value : (typeof value === 'object' ? JSON.stringify(value) : String(value)));
            } else {
                assignPath(json, name, value);
            }
        });

        for (const [key, val] of query) url.searchParams.set(key, val);
        if (!useForm && ['POST', 'PUT', 'PATCH'].includes(requestMethod)) headers['Content-Type'] = 'application/json';
        return {
            endpoint,
            url: url.toString(),
            method: endpoint.method || 'POST',
            headers,
            body: useForm ? form : JSON.stringify(json),
            payload: useForm ? Object.fromEntries(form) : json,
            isAsync: D(endpoint.p).includes('/async/')
        };
    }

    function updateConsolePreview() {
        try {
            const request = buildConsoleRequest();
            document.getElementById('zimg-console-preview').value = [
                `${request.method} ${request.url}`,
                ...Object.entries(request.headers).map(([key, value]) => `${key}: ${key === 'Authorization' ? 'Bearer $TOKEN' : value}`),
                '',
                typeof request.payload === 'string' ? request.payload : JSON.stringify(request.payload, null, 2)
            ].join('\n');
        } catch (_) {}
    }

    async function refreshOpenApiConsole() {
        const response = await requestJson({ method: 'GET', url: API_BASE + '/v1/json', headers: { Authorization: `Bearer ${cleanToken(tokenInput.value)}` } });
        if (response.status < 200 || response.status >= 300) throw new Error(requestErrorMessage(response.status, response.data, response.data && response.data.raw));
        openapiSchema = response.data;
        const generated = [];
        const dictionaryLookup = new Map(controlsSchema.d.map((text, index) => [text, index]));
        const intern = (value) => {
            const text = String(value);
            if (!dictionaryLookup.has(text)) {
                controlsSchema.d.push(text);
                dictionaryLookup.set(text, controlsSchema.d.length - 1);
            }
            return dictionaryLookup.get(text);
        };
        const jsonIntern = (value) => value === undefined || value === null ? -1 : intern(JSON.stringify(value));
        const resolveRef = (schema, depth = 0) => {
            if (!schema || depth > 5) return {};
            if (schema.$ref) {
                const node = schema.$ref.replace(/^#\//, '').split('/').reduce((item, key) => item && item[key], openapiSchema);
                return resolveRef(node, depth + 1);
            }
            if (schema.allOf) return Object.assign({}, ...schema.allOf.map(item => resolveRef(item, depth + 1)), schema);
            return schema;
        };
        const flatten = (schema, prefix, required, output, depth) => {
            const resolved = resolveRef(schema, depth);
            if (resolved.type === 'object' && resolved.properties && depth < 3) {
                Object.entries(resolved.properties).forEach(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key, resolved.required || [], output, depth + 1));
                return;
            }
            output.push({
                k: prefix,
                l: 'body',
                t: resolved.type || 'string',
                q: required.includes(prefix.split('.').pop()) ? 1 : 0,
                c: JSON.stringify([resolved.enum ? 'select' : resolved.type === 'boolean' ? 'boolean' : resolved.type === 'array' ? 'array' : resolved.type === 'number' || resolved.type === 'integer' ? 'number' : 'text']),
                d: (resolved.description || '').replace(/\s+/g, ' '),
                f: resolved.default === undefined ? [] : [resolved.default],
                r: resolved.minimum === undefined && resolved.maximum === undefined ? [] : [{ min: resolved.minimum, max: resolved.maximum, step: resolved.multipleOf }],
                o: resolved.enum || [],
                v: null
            });
        };
        Object.entries(openapiSchema.paths || {}).forEach(([path, methods]) => {
            Object.entries(methods).forEach(([method, operation]) => {
                if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) return;
                const tags = operation.tags || [];
                if (!tags.some(tag => OPEN_API_ALLOWED_TAGS.has(tag))) return;
                const parameters = [];
                (operation.parameters || []).forEach(parameter => parameters.push({
                    k: parameter.name,
                    l: parameter.in,
                    t: parameter.schema && parameter.schema.type || 'string',
                    q: parameter.required ? 1 : 0,
                    c: JSON.stringify([parameter.schema && parameter.schema.enum ? 'select' : parameter.schema && parameter.schema.type === 'boolean' ? 'boolean' : 'text']),
                    d: parameter.description || '',
                    f: parameter.schema && parameter.schema.default !== undefined ? [parameter.schema.default] : [],
                    r: parameter.schema && (parameter.schema.minimum !== undefined || parameter.schema.maximum !== undefined) ? [{ min: parameter.schema.minimum, max: parameter.schema.maximum }] : [],
                    o: parameter.schema && parameter.schema.enum || [],
                    v: null
                }));
                const requestBody = operation.requestBody && operation.requestBody.content;
                if (requestBody) {
                    const media = requestBody['application/json'] || requestBody['multipart/form-data'] || Object.values(requestBody)[0];
                    if (media && media.schema) flatten(media.schema, '', media.schema.required || [], parameters, 0);
                }
                generated.push({
                    p: intern(path.replace(/^\//, '')),
                    method: method.toUpperCase(),
                    origin: 'openapi',
                    o: [{ id: operation.operationId || path, name: operation.summary || operation.operationId || method.toUpperCase(), model: null, format: intern('OPEN_API'), price: null, free: true, status: intern('metadata') }],
                    n: parameters.length,
                    r: parameters
                });
            });
        });
        consoleEndpoints = consoleEndpoints.filter(item => item.origin === 'operations').concat(generated);
        fillConsoleEndpoints();
        document.getElementById('zimg-console-state').textContent = `已加载 ${generated.length} 个 OpenAPI 操作`;
        renderConsoleForm();
    }

    function extractConsoleResult(data) {
        if (typeof data === 'string') return data;
        const candidates = [data.data, data.output, data.result, data];
        for (const candidate of candidates) {
            if (!candidate) continue;
            if (typeof candidate === 'string') return candidate;
            if (Array.isArray(candidate)) {
                const first = candidate[0] || {};
                if (first.url) return first.url;
                if (first.b64_json) return 'data:image/png;base64,' + first.b64_json;
            }
            if (candidate.url) return candidate.url;
            if (candidate.file_url) return candidate.file_url;
            if (candidate.text_result) return candidate.text_result;
            if (candidate.choices && candidate.choices[0]) {
                const message = candidate.choices[0].message || candidate.choices[0].delta || {};
                if (message.content) return message.content;
            }
        }
        return null;
    }

    async function runConsoleRequest() {
        const state = document.getElementById('zimg-console-state');
        try {
            const request = buildConsoleRequest();
            const operation = (request.endpoint.o || [])[Number(document.getElementById('zimg-console-operation').value || 0)];
            if (operation && !operation.free && !document.getElementById('zimg-console-paid-confirm').checked) {
                throw new Error('付费调用需要先勾选费用确认');
            }
            state.textContent = '请求中…';
            const created = await requestJson({ method: request.method, url: request.url, headers: request.headers, data: request.body });
            if (created.status < 200 || created.status >= 300) throw new Error(requestErrorMessage(created.status, created.data, created.data && created.data.raw));
            const taskId = created.data.task_id || (created.data.data && created.data.data.task_id);
            const consoleMeta = {
                mode: 'console',
                model: operation ? D(operation.model) : '',
                taskId: taskId || ''
            };
            if (request.isAsync && taskId) {
                activeTaskId = taskId;
                activeTaskUrls = created.data.urls || created.data.task_urls || null;
                state.textContent = `任务已提交：${taskId}`;
                const resultUrl = await pollTask(taskId, cleanToken(tokenInput.value), '');
                const extracted = extractConsoleResult(created.data) || resultUrl;
                currentResult = { url: extracted, kind: mediaKind(extracted, 'console'), ext: extFromUrl(extracted, 'bin') };
                showResult(currentResult, '控制台任务');
                addToHistory(currentResult, '控制台任务', consoleMeta);
            } else {
                const extracted = extractConsoleResult(created.data);
                if (extracted) {
                    if (/^(https?:|data:)/.test(extracted)) {
                        currentResult = { url: extracted, kind: mediaKind(extracted, 'console'), ext: extFromUrl(extracted, 'bin') };
                    } else {
                        currentResult = { kind: 'text', text: String(extracted), ext: 'txt' };
                    }
                    showResult(currentResult, '控制台结果');
                    addToHistory(currentResult, '控制台结果', consoleMeta);
                }
            }
            document.getElementById('zimg-console-response').value = JSON.stringify(created.data, null, 2);
            state.textContent = `成功：HTTP ${created.status}`;
        } catch (error) {
            state.textContent = '失败';
            document.getElementById('zimg-console-response').value = error.message;
        }
    }

    async function openConsole() {
        consoleOverlay.style.display = 'flex';
        try {
            await loadControlsSchema();
            fillConsoleEndpoints();
            fillConsoleOperations();
            renderConsoleForm();
            document.getElementById('zimg-console-source').textContent += '\n\n离线快照日期：' + controlsSchema.generatedAt;
        } catch (error) {
            document.getElementById('zimg-console-source').textContent = error.message;
        }
    }

    function closeConsole() {
        consoleOverlay.style.display = 'none';
    }

    function requestErrorMessage(status, data, text) {
        const detail = (data && (data.message || data.error_message)) || (text || '').slice(0, 300) || '无详细错误';
        return `HTTP ${status}：${detail}`;
    }

    function validateToken() {
        const token = cleanToken(tokenInput.value);
        if (!token) {
            showStatus('error', '❌ 请先填写或获取访问令牌。');
            tokenInput.focus();
            throw new Error('token-required');
        }
        if (DUMMY_TOKENS.includes(token)) {
            showStatus('error', '❌ 这是占位 Token，请点击自动同步或粘贴有效令牌。');
            tokenInput.focus();
            throw new Error('token-dummy');
        }
        tokenInput.value = token;
        const persisted = safeGM.setValuePrivate(STORAGE_TOKEN_KEY, token);
        if (!persisted && typeof GM_setValue === 'undefined') {
            showStatus('error', '⚠️ 当前环境无法安全保存令牌，本次仅保留在输入框中。');
        }
        return token;
    }

    function requirePrompt() {
        const prompt = promptInput.value.trim();
        if (!prompt) {
            showStatus('error', currentMode === 'speech' ? '❌ 请输入合成文本' : currentMode === 'chat' ? '❌ 请输入消息内容' : '❌ 请输入提示词');
            promptInput.focus();
            throw new Error('prompt-required');
        }
        return prompt;
    }

    function requireFile(inputId) {
        const file = document.getElementById(inputId).files[0];
        if (!file) {
            showStatus('error', '❌ 请先选择源图片');
            throw new Error('file-required');
        }
        return file;
    }

    let generatePhase = '提交任务中';

    function beginGeneration() {
        isGenerating = true;
        cancelRequested = false;
        activeTaskId = null;
        activeTaskUrls = null;
        generateBtn.disabled = true;
        resultBox.style.display = 'none';
        generateStartTime = Date.now();
        generatePhase = '提交任务中';
        updateGenerationStatus(generatePhase);
        // 每秒刷新已耗时，避免长任务期间状态栏静止不动
        generateTimer = setInterval(() => {
            if (isGenerating) updateGenerationStatus(generatePhase);
        }, 1000);
    }

    function updateGenerationStatus(prefix) {
        const elapsed = ((Date.now() - generateStartTime) / 1000).toFixed(1);
        showStatus('loading', `${prefix} 已耗时 ${elapsed}s`);
    }

    function finishGeneration() {
        isGenerating = false;
        activeTaskId = null;
        activeTaskUrls = null;
        cancelRequested = false;
        clearInterval(generateTimer);
        generateBtn.disabled = false;
        cancelBtn.style.display = 'none';
    }

    function optionalNumber(value) {
        if (value === '' || value === null || value === undefined) return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    function optionalCheckedNumber(id, label, { min = 0, max = 2147483647, integer = true } = {}) {
        const value = optionalNumber(document.getElementById(id).value);
        if (value === undefined) return undefined;
        if (value < min || value > max || (integer && !Number.isInteger(value))) {
            throw new Error(`${label} 需为 ${min}-${max}${integer ? ' 的整数' : ''}`);
        }
        return value;
    }

    function addIfPresent(target, key, value) {
        if (value !== undefined && value !== null && value !== '') target[key] = value;
    }

    function addIfPresent2(form, key, value) {
        if (value !== undefined && value !== null && String(value).trim() !== '') form.append(key, String(value));
    }

    function buildImagePayload(prompt) {
        const [width, height] = sizeSelect.value.split('x').map(Number);
        if (!width || !height || width < 64 || height < 64 || width > 2048 || height > 2048) {
            throw new Error('快速图片尺寸需在 64-2048 像素内');
        }
        const payload = {
            model: getModeSelect('image').value,
            prompt,
            size: sizeSelect.value,
            width,
            height,
            num_inference_steps: Number(stepsSlider.value)
        };
        addIfPresent(payload, 'negative_prompt', negativeInput.value.trim());
        addIfPresent(payload, 'guidance_scale', optionalCheckedNumber('zimg-image-guidance', 'Guidance', { min: 0, max: 100, integer: false }));
        addIfPresent(payload, 'seed', optionalCheckedNumber('zimg-image-seed', 'Seed'));
        payload.response_format = document.getElementById('zimg-image-format').value;
        const count = Number(document.getElementById('zimg-image-count').value);
        if (count > 1) payload.num_images_per_prompt = count;
        return payload;
    }

    function buildTextVideoPayload(prompt) {
        const model = getModeSelect('textVideo').value;
        const config = getModelConfig('textVideo');
        const payload = {
            model,
            prompt,
            num_frames: Number(document.getElementById('zimg-t2v-frames').value),
            num_inference_steps: Number(document.getElementById('zimg-t2v-steps').value)
        };
        addIfPresent(payload, 'negative_prompt', negativeInput.value.trim());
        addIfPresent(payload, 'seed', optionalCheckedNumber('zimg-t2v-seed', 'Seed'));
        if (config.aspect) payload.aspect_ratio = document.getElementById('zimg-t2v-aspect').value;
        if (config.fps) payload.fps = Number(document.getElementById('zimg-t2v-fps').value);
        return payload;
    }

    function buildSpeechPayload(text) {
        return {
            model: getModeSelect('speech').value,
            inputs: text,
            gender: document.getElementById('zimg-speech-gender').value,
            pitch: Number(document.getElementById('zimg-speech-pitch').value),
            speed: Number(document.getElementById('zimg-speech-speed').value),
            response_format: 'url'
        };
    }

    // ===================== 文本对话 / 语音识别 =====================
    let chatMessages = [];

    function updateChatStateLabel() {
        const el = document.getElementById('zimg-chat-state');
        if (el) el.innerText = chatMessages.length ? `已进行 ${chatMessages.length / 2} 轮对话` : '尚未开始';
    }

    document.getElementById('zimg-btn-new-chat').addEventListener('click', () => {
        chatMessages = [];
        updateChatStateLabel();
        resultBox.style.display = 'none';
        showStatus('success', '🧹 已开始新对话');
        setTimeout(() => { if (!isGenerating) statusBox.style.display = 'none'; }, 1500);
    });

    function buildChatPayload(userMsg) {
        const payload = {
            model: getModeSelect('chat').value,
            messages: []
        };
        const system = document.getElementById('zimg-chat-system').value.trim();
        if (system) payload.messages.push({ role: 'system', content: system });
        payload.messages.push(...chatMessages, { role: 'user', content: userMsg });
        addIfPresent(payload, 'temperature', optionalNumber(document.getElementById('zimg-chat-temp').value));
        addIfPresent(payload, 'max_tokens', optionalNumber(document.getElementById('zimg-chat-max-tokens').value));
        addIfPresent(payload, 'top_p', optionalNumber(document.getElementById('zimg-chat-top-p').value));
        addIfPresent(payload, 'frequency_penalty', optionalNumber(document.getElementById('zimg-chat-freq-penalty').value));
        addIfPresent(payload, 'presence_penalty', optionalNumber(document.getElementById('zimg-chat-pres-penalty').value));
        return payload;
    }

    function buildAsrForm(file) {
        const form = new FormData();
        form.append('file', file, file.name);
        form.append('model', getModeSelect('asr').value);
        const language = document.getElementById('zimg-asr-language').value;
        if (language) form.append('language', language);
        return form;
    }

    // 流式对话：解析 SSE 增量（data: {...} / data: [DONE]），实时渲染到结果区；
    // 若环境不支持进度回调（onprogress 无 responseText），onload 后仍能拿到完整结果兜底
    function streamChatCompletion(payload, token) {
        return new Promise((resolve, reject) => {
            let pendingLine = '';
            let fullText = '';
            let gotAnyDelta = false;
            let liveStarted = false;

            const handleLine = (line) => {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) return;
                const data = trimmed.slice(5).trim();
                if (!data || data === '[DONE]') return;
                try {
                    const obj = JSON.parse(data);
                    const choice = obj.choices && obj.choices[0];
                    const delta = choice && (choice.delta || choice.message);
                    const piece = (delta && (delta.content || delta.reasoning_content)) || '';
                    if (piece) {
                        fullText += piece;
                        gotAnyDelta = true;
                        if (!liveStarted) {
                            liveStarted = true;
                            hideResultMedia();
                            resultBox.style.display = 'flex';
                            previewText.style.display = '';
                        }
                        previewText.textContent += piece;
                        previewText.scrollTop = previewText.scrollHeight;
                    }
                } catch (e) {}
            };

            // onprogress 的 responseText 是“到目前为止的完整文本”，用游标只消费新增部分
            let consumedIndex = 0;
            const consume = (fullSoFar) => {
                pendingLine += fullSoFar.slice(consumedIndex);
                consumedIndex = fullSoFar.length;
                const lines = pendingLine.split('\n');
                pendingLine = lines.pop();
                for (const line of lines) handleLine(line);
            };

            safeGM.xmlhttpRequest({
                method: 'POST',
                url: API_BASE + ENDPOINTS.chat,
                timeout: 120000,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'X-Failover-Enabled': 'true'
                },
                data: JSON.stringify(Object.assign({}, payload, { stream: true })),
                onprogress: (res) => {
                    try {
                        if (typeof res.responseText === 'string' && res.responseText) {
                            generatePhase = '模型输出中';
                            consume(res.responseText);
                        }
                    } catch (e) {}
                },
                onload: (res) => {
                    if (pendingLine) {
                        handleLine(pendingLine);
                        pendingLine = '';
                    }
                    if (res.status < 200 || res.status >= 300) {
                        let errData = null;
                        try { errData = JSON.parse(res.responseText); } catch (e) {}
                        reject(new Error(requestErrorMessage(res.status, errData, res.responseText)));
                        return;
                    }
                    if (!gotAnyDelta) {
                        // onprogress 未提供数据（个别管理器实现），按非流式完整解析兜底
                        try {
                            const obj = JSON.parse(res.responseText);
                            const message = obj.choices && obj.choices[0] && obj.choices[0].message;
                            fullText = (message && (message.content || message.reasoning_content)) || '';
                        } catch (e) {}
                    }
                    resolve({ text: fullText, status: res.status });
                },
                onerror: () => reject(new Error('网络请求失败')),
                ontimeout: () => reject(new Error('请求超时'))
            });
        });
    }

    function buildImageVideoForm(prompt, file) {
        const form = new FormData();
        const config = getModelConfig('imageVideo');
        form.append('model', getModeSelect('imageVideo').value);
        form.append('image', file, file.name);
        form.append('prompt', prompt);
        form.append('num_frames', document.getElementById('zimg-i2v-frames').value);
        form.append('width', document.getElementById('zimg-i2v-width').value);
        form.append('height', document.getElementById('zimg-i2v-height').value);
        form.append('num_inference_steps', document.getElementById('zimg-i2v-steps').value);
        if (config.fps) form.append('fps', document.getElementById('zimg-i2v-fps').value);
        if (config.guidance) form.append('guidance_scale', document.getElementById('zimg-i2v-guidance').value);
        const seed = optionalCheckedNumber('zimg-i2v-seed', 'Seed');
        if (seed !== undefined) form.append('seed', String(seed));
        const negative = negativeInput.value.trim();
        if (negative && config.guidance) form.append('negative_prompt', negative);
        return form;
    }

    function buildThreeDForm(file) {
        const form = new FormData();
        const model = getModeSelect('threeD').value;
        const config = getModelConfig('threeD');
        form.append('model', model);
        form.append('image', file, file.name);
        const seed = optionalCheckedNumber('zimg-3d-seed', 'Seed');
        if (seed !== undefined) form.append('seed', String(seed));
        if (config.format) form.append('file_format', document.getElementById('zimg-3d-format').value);
        if (model === 'Hunyuan3D-2') {
            form.append('type', document.getElementById('zimg-3d-format').value);
            form.append('num_inference_steps', document.getElementById('zimg-3d-steps').value);
            form.append('octree_resolution', document.getElementById('zimg-3d-octree').value);
            form.append('guidance_scale', document.getElementById('zimg-3d-guidance').value);
            form.append('texture', document.getElementById('zimg-3d-texture').checked ? 'true' : 'false');
            form.append('foreground_detection', document.getElementById('zimg-3d-foreground').checked ? 'true' : 'false');
            addIfPresent2(form, 'mc_resolution', document.getElementById('zimg-3d-mc-resolution').value);
            addIfPresent2(form, 'face_count', document.getElementById('zimg-3d-face-count').value);
        }
        return form;
    }

    function mediaKind(url, mode) {
        const ext = extFromUrl(url, '');
        if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
        if (['wav', 'mp3', 'mpeg', 'ogg', 'm4a'].includes(ext)) return 'audio';
        if (mode === 'threeD' || ['glb', 'stl', 'obj'].includes(ext)) return 'model';
        if (mode === 'speech') return 'audio';
        return 'image';
    }

    async function pollTask(taskId, token, prompt) {
        const returnedUrl = activeTaskUrls && (activeTaskUrls.get || activeTaskUrls.status || activeTaskUrls.detail);
        const statusUrl = returnedUrl || `${API_BASE}/v1/task/${encodeURIComponent(taskId)}`;
        const headers = { Authorization: `Bearer ${token}` };
        const deadline = Date.now() + 15 * 60 * 1000;
        while (Date.now() < deadline) {
            for (let i = 0; i < 16 && !cancelRequested; i++) {
                await sleep(250);
            }
            if (cancelRequested) break;
            generatePhase = '云端推理中';
            updateGenerationStatus(generatePhase);
            let response;
            try {
                response = await requestJson({ method: 'GET', url: statusUrl, headers });
            } catch (_) {
                continue;
            }
            const task = response.data || {};
            if (response.status < 200 || response.status >= 300) {
                throw new Error(requestErrorMessage(response.status, task, response.data && response.data.raw));
            }
            if (task.status === 'success') {
                const url = task.output && (task.output.file_url || task.output.url || task.output.text_result);
                if (!url) throw new Error('任务成功但返回体缺少文件地址');
                return url;
            }
            if (task.status === 'failure' || task.status === 'failed' || task.status === 'cancelled') {
                throw new Error(`任务${task.status === 'cancelled' ? '已取消' : '失败'}：${task.message || task.error || '无详细信息'}`);
            }
        }
        throw new Error('等待任务超时，可稍后在 Gitee AI 任务页查看结果');
    }

    async function runJsonGeneration(endpoint, payload, prompt, token) {
        const created = await requestJson({
            method: 'POST',
            url: API_BASE + endpoint,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-Failover-Enabled': 'true'
            },
            data: JSON.stringify(payload)
        });
        if (created.status < 200 || created.status >= 300) {
            throw new Error(requestErrorMessage(created.status, created.data, created.data && created.data.raw));
        }
        const taskId = created.data.task_id;
        if (!taskId) throw new Error('接口未返回 task_id');
        activeTaskId = taskId;
        activeTaskUrls = created.data.urls || created.data.task_urls || null;
        cancelBtn.style.display = '';
        const url = await pollTask(taskId, token, prompt);
        const kind = mediaKind(url, currentMode);
        showResult({ url, kind, ext: extFromUrl(url, { video: 'mp4', audio: 'mpeg', model: 'glb' }[kind] || 'bin') }, prompt);
        addToHistory(currentResult, prompt, {
            mode: currentMode,
            model: getModeSelect(currentMode).value,
            taskId
        });
    }

    async function doGenerate() {
        if (isGenerating) return;
        let token;
        try {
            token = validateToken();
            beginGeneration();
            if (downloadDirectoryHandle && downloadDirectoryNeedsPermission) {
                const granted = await hasDirectoryPermission(downloadDirectoryHandle, true);
                downloadDirectoryNeedsPermission = !granted;
                renderSaveDirectoryState();
            }
            if (currentMode === 'image') {
                const prompt = requirePrompt();
                const payload = buildImagePayload(prompt);
                const response = await requestJson({
                    method: 'POST',
                    url: API_BASE + ENDPOINTS.image,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'X-Failover-Enabled': 'true'
                    },
                    data: JSON.stringify(payload)
                });
                if (response.status < 200 || response.status >= 300) {
                    throw new Error(requestErrorMessage(response.status, response.data, response.data && response.data.raw));
                }
                const item = response.data.data && response.data.data[0];
                if (!item) throw new Error('接口未返回图片数据');
                const url = item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url;
                if (!url) throw new Error('返回数据缺少 b64_json 或 url');
                currentResult = { url, kind: 'image', ext: item.b64_json ? 'png' : extFromUrl(url, 'png') };
                const quota = consumeOneQuota();
                updateQuotaDisplay(quota);
                showResult(currentResult, prompt);
                addToHistory(currentResult, prompt, {
                    mode: 'image',
                    model: getModeSelect('image').value,
                    taskId: activeTaskId
                });
            } else if (currentMode === 'textVideo') {
                const prompt = requirePrompt();
                await runJsonGeneration(ENDPOINTS.textVideo, buildTextVideoPayload(prompt), prompt, token);
            } else if (currentMode === 'speech') {
                const text = requirePrompt();
                await runJsonGeneration(ENDPOINTS.speech, buildSpeechPayload(text), text, token);
            } else if (currentMode === 'imageVideo') {
                const prompt = requirePrompt();
                const file = requireFile('zimg-i2v-file');
                const created = await requestJson({
                    method: 'POST',
                    url: API_BASE + ENDPOINTS.imageVideo,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'X-Failover-Enabled': 'true'
                    },
                    data: buildImageVideoForm(prompt, file)
                });
                if (created.status < 200 || created.status >= 300) throw new Error(requestErrorMessage(created.status, created.data, created.data && created.data.raw));
                if (!created.data.task_id) throw new Error('接口未返回 task_id');
                activeTaskId = created.data.task_id;
                activeTaskUrls = created.data.urls || created.data.task_urls || null;
                cancelBtn.style.display = '';
                const url = await pollTask(activeTaskId, token, prompt);
                currentResult = { url, kind: 'video', ext: extFromUrl(url, 'mp4') };
                showResult(currentResult, prompt);
                addToHistory(currentResult, prompt, {
                    mode: 'imageVideo',
                    model: getModeSelect('imageVideo').value,
                    taskId: activeTaskId
                });
            } else if (currentMode === 'threeD') {
                const file = requireFile('zimg-3d-file');
                const created = await requestJson({
                    method: 'POST',
                    url: API_BASE + ENDPOINTS.threeD,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'X-Failover-Enabled': 'true'
                    },
                    data: buildThreeDForm(file)
                });
                if (created.status < 200 || created.status >= 300) throw new Error(requestErrorMessage(created.status, created.data, created.data && created.data.raw));
                if (!created.data.task_id) throw new Error('接口未返回 task_id');
                activeTaskId = created.data.task_id;
                activeTaskUrls = created.data.urls || created.data.task_urls || null;
                cancelBtn.style.display = '';
                const url = await pollTask(activeTaskId, token, '');
                currentResult = { url, kind: 'model', ext: extFromUrl(url, 'glb'), filename: `model-${Date.now()}.${extFromUrl(url, 'glb')}` };
                showResult(currentResult, '');
                addToHistory(currentResult, `${getModeSelect('threeD').value} 3D 模型`, {
                    mode: 'threeD',
                    model: getModeSelect('threeD').value,
                    taskId: activeTaskId
                });
            } else if (currentMode === 'chat') {
                const userMsg = requirePrompt();
                const payload = buildChatPayload(userMsg);
                const useStream = document.getElementById('zimg-chat-stream').checked;
                let content = '';
                if (useStream) {
                    const streamed = await streamChatCompletion(payload, token);
                    content = streamed.text;
                } else {
                    generatePhase = '等待模型回复';
                    const response = await requestJson({
                        method: 'POST',
                        url: API_BASE + ENDPOINTS.chat,
                        headers: {
                            Authorization: `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            'X-Failover-Enabled': 'true'
                        },
                        data: JSON.stringify(payload)
                    });
                    if (response.status < 200 || response.status >= 300) throw new Error(requestErrorMessage(response.status, response.data, response.data && response.data.raw));
                    const message = response.data.choices && response.data.choices[0] && response.data.choices[0].message;
                    // DeepSeek-R1 类推理模型可能只返回 reasoning_content
                    content = (message && (message.content || message.reasoning_content)) || '';
                }
                if (!content) throw new Error('接口未返回回复内容');
                chatMessages.push({ role: 'user', content: userMsg }, { role: 'assistant', content });
                if (chatMessages.length > 20) chatMessages = chatMessages.slice(-20);
                updateChatStateLabel();
                currentResult = { kind: 'text', text: content, ext: 'txt' };
                showResult(currentResult, userMsg);
                addToHistory(currentResult, userMsg, {
                    mode: 'chat',
                    model: getModeSelect('chat').value,
                    taskId: activeTaskId
                });
            } else if (currentMode === 'asr') {
                const file = requireFile('zimg-asr-file');
                generatePhase = '上传音频并识别中';
                const response = await requestJson({
                    method: 'POST',
                    url: API_BASE + ENDPOINTS.asr,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'X-Failover-Enabled': 'true'
                    },
                    data: buildAsrForm(file)
                });
                if (response.status < 200 || response.status >= 300) throw new Error(requestErrorMessage(response.status, response.data, response.data && response.data.raw));
                const text = response.data.text || (response.data.segments && response.data.segments.map(s => s.text).join('')) || '';
                if (!text) throw new Error('接口未返回识别文本');
                currentResult = { kind: 'text', text, ext: 'txt' };
                showResult(currentResult, `语音识别：${file.name}`);
                addToHistory(currentResult, `🎙 ${file.name}`, {
                    mode: 'asr',
                    model: getModeSelect('asr').value,
                    taskId: activeTaskId
                });
            }
            const totalTime = ((Date.now() - generateStartTime) / 1000).toFixed(1);
            showStatus('success', `🎉 生成成功（耗时 ${totalTime}s）`);
        } catch (error) {
            if (['token-required', 'token-dummy', 'prompt-required', 'file-required'].includes(error.message)) return;
            if (cancelRequested) {
                showStatus('error', '⏹ 已取消任务');
            } else {
                console.error('[Gitee AI Generator]', error);
                showStatus('error', `❌ 生成失败：${error.message}`);
            }
        } finally {
            finishGeneration();
        }
    }

    generateBtn.addEventListener('click', doGenerate);

    cancelBtn.addEventListener('click', async () => {
        if (!activeTaskId) return;
        cancelRequested = true;
        try {
            await requestJson({
                method: 'POST',
                url: (activeTaskUrls && activeTaskUrls.cancel) || `${API_BASE}/v1/task/${encodeURIComponent(activeTaskId)}/cancel`,
                headers: { Authorization: `Bearer ${cleanToken(tokenInput.value)}` }
            });
            showStatus('error', '⏹ 正在取消云端任务...');
        } catch (_) {
            showStatus('error', '⚠️ 取消请求已发送失败，可继续等待当前轮询结束');
        }
    });

    downloadBtn.addEventListener('click', () => {
        if (!currentResult) return;
        const filename = `gitee-ai-${currentMode}-${Date.now()}.${currentResult.ext || 'bin'}`;
        const a = document.createElement('a');
        if (currentResult.kind === 'text') {
            const blob = new Blob([currentResult.text], { type: 'text/plain;charset=utf-8' });
            a.href = URL.createObjectURL(blob);
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            return;
        }
        a.href = currentResult.url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });

    copyLinkBtn.addEventListener('click', () => {
        if (!currentResult) return;
        const isText = currentResult.kind === 'text';
        const copyValue = isText ? currentResult.text : (currentResult.sourceUrl || currentResult.url);
        navigator.clipboard.writeText(copyValue).then(() => {
            showStatus('success', isText ? '✅ 文本内容已复制到剪贴板' : '✅ 结果链接已复制到剪贴板');
            setTimeout(() => { if (!isGenerating) statusBox.style.display = 'none'; }, 2000);
        }).catch(err => {
            showStatus('error', '❌ 复制失败：' + err);
        });
    });

    if (typeof GM_registerMenuCommand !== 'undefined') {
        try {
            GM_registerMenuCommand("🎨 打开 Gitee AI 生成工作台", () => {
                openModal();
            });
            GM_registerMenuCommand("🔄 重新自动获取访问令牌", () => refreshToken(true));
            GM_registerMenuCommand("🤖 导出 Agent 提示词（供 Codex 等调用接口）", () => {
                openModal();
                openAgentDialog();
            });
        } catch (e) {}
    }

    // 打开官网即自动获取：页面加载后立即轻量探测一次令牌并预填（跳过 React 深扫避免大页面卡顿）
    try {
        const preToken = autoDetectToken(true);
        if (preToken) {
            tokenInput.value = preToken;
            updateQuotaDisplay();
        }
    } catch (e) {}

    // SPA 路由/框架重绘保护：若悬浮按钮或面板被页面移除则自动挂回，保证任意页面可用
    const persistenceObserver = new MutationObserver(() => {
        try {
            if (fab && !fab.isConnected) document.body.appendChild(fab);
            if (overlay && !overlay.isConnected) document.body.appendChild(overlay);
        } catch (e) {}
    });
    try {
        persistenceObserver.observe(document.body, { childList: true });
    } catch (e) {}

    // 卸载钩子
    window.__Z_IMAGE_DESTROY__ = () => {
        try { persistenceObserver.disconnect(); } catch (e) {}
        style.remove();
        fab.remove();
        overlay.remove();
        agentOverlay.remove();
    };

})();
