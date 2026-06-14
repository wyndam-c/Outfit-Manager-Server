// ── 穿搭管理器 · 后端存储插件 ──────────────────────────────
// SillyTavern server plugin — 持久化穿搭数据 + 图片分离存储
//
// 路由（自动挂载在 /api/plugins/outfit-manager/ 之下）：
//   GET    /status              健康探测，前端用来决定是否启用 server 模式
//   GET    /data                读取完整穿搭元数据（图片字段为 URL）
//   PUT    /data                写入完整元数据；自动抽取 base64 图片到磁盘
//   POST   /images              单张图片上传（base64 body），返回 URL
//   POST   /images/batch-fetch  批量取图片 base64（导出用），只接受本插件路径
//   GET    /images/:name        读取单张图片文件
//   POST   /gc                  清理未引用图片（支持 dry-run）
//
// 设计要点：
//   - 图片以 SHA1 内容寻址命名，同图去重
//   - PUT /data 时自动分离 base64（兼容首次迁移场景）
//   - fabImage 也纳入图片分离
//   - batch-fetch 只接受本插件生成的路径，不做开放代理
//   - 只允许 jpg/png/webp/gif/bmp，禁止 SVG（安全考量）
//   - 写文件用 tmp → rename 原子操作

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const info = {
    id: 'outfit-manager',
    name: 'Outfit Manager Storage',
    description: 'Server-side persistence backend for the Outfit Manager extension.',
};

// ── 路径常量 ────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const DATA_FILE = path.join(DATA_DIR, 'outfits.json');
const IMAGE_URL_PREFIX = '/api/plugins/outfit-manager/images/';

// ── 校验正则 ────────────────────────────────────────────
const DATA_URL_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;
const SAFE_NAME_RE = /^[a-f0-9]{40}\.[a-z0-9]+$/i;

// 允许的图片类型白名单（禁止 SVG）
const ALLOWED_EXTENSIONS = new Set(['jpg', 'png', 'webp', 'gif', 'bmp']);

// ── 工具函数 ────────────────────────────────────────────
function ensureDirsSync() {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

function extFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m === 'jpeg' || m === 'jpg' || m === 'pjpeg') return 'jpg';
    if (m === 'png') return 'png';
    if (m === 'webp') return 'webp';
    if (m === 'gif') return 'gif';
    if (m === 'bmp') return 'bmp';
    return null; // 不在白名单则拒绝
}

function isValidImageName(name) {
    if (!SAFE_NAME_RE.test(name)) return false;
    const ext = name.split('.').pop().toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
}

// ── 数据文件读写 ────────────────────────────────────────
async function readDataFile() {
    try {
        const buf = await fsp.readFile(DATA_FILE, 'utf-8');
        return JSON.parse(buf);
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
    }
}

async function writeDataFile(obj) {
    const tmp = DATA_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(obj), 'utf-8');
    await fsp.rename(tmp, DATA_FILE);
}

// ── 图片存储核心 ────────────────────────────────────────
// 将 base64 dataURL 存为文件，返回 { name, url } 或 null
async function storeBase64Image(dataUrl) {
    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) return null;

    const ext = extFromMime(m[1]);
    if (!ext) return null; // 不在白名单（如 SVG）

    const raw = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
    const hash = crypto.createHash('sha1').update(raw).digest('hex');
    const name = hash + '.' + ext;
    const filePath = path.join(IMAGES_DIR, name);

    try {
        await fsp.access(filePath);
    } catch {
        await fsp.writeFile(filePath, raw);
    }
    return { name: name, url: IMAGE_URL_PREFIX + name };
}

// 读取图片文件返回 dataURL
async function imageToDataUrl(name) {
    if (!isValidImageName(name)) return null;
    const filePath = path.join(IMAGES_DIR, name);
    // 二次路径穿越校验
    if (!filePath.startsWith(IMAGES_DIR + path.sep) && filePath !== path.join(IMAGES_DIR, name)) {
        return null;
    }
    try {
        const buf = await fsp.readFile(filePath);
        const ext = name.split('.').pop().toLowerCase();
        const mimeMap = { jpg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp' };
        const mime = mimeMap[ext] || 'jpeg';
        return 'data:image/' + mime + ';base64,' + buf.toString('base64');
    } catch {
        return null;
    }
}

// ── 批量抽取 base64 → 文件 ──────────────────────────────
// 遍历 outfit 数组，把 base64 imageData 存文件并替换为 URL
// 返回 referenced 集合（所有仍被引用的图片文件名）
async function externalizeImages(outfits, referenced) {
    if (!Array.isArray(outfits)) return;
    for (const o of outfits) {
        if (!o || typeof o !== 'object') continue;
        const v = o.imageData;
        if (typeof v !== 'string' || !v) continue;

        // 已经是本插件 URL
        if (v.startsWith(IMAGE_URL_PREFIX)) {
            const name = path.basename(v);
            if (isValidImageName(name)) referenced.add(name);
            continue;
        }

        // base64 dataURL → 存文件
        const result = await storeBase64Image(v);
        if (result) {
            o.imageData = result.url;
            referenced.add(result.name);
        }
        // 其他格式（http 链接等）原样保留
    }
}

async function externalizeAllImages(data) {
    if (!data || typeof data !== 'object') return new Set();
    const referenced = new Set();

    // User outfits
    await externalizeImages(data.outfits, referenced);

    // Char outfits
    if (data.chars && typeof data.chars === 'object') {
        for (const k of Object.keys(data.chars)) {
            const c = data.chars[k];
            if (c && Array.isArray(c.outfits)) {
                await externalizeImages(c.outfits, referenced);
            }
        }
    }

    // Presets
    if (Array.isArray(data.presets)) {
        for (const p of data.presets) {
            if (p && Array.isArray(p.outfits)) {
                await externalizeImages(p.outfits, referenced);
            }
        }
    }

    // fabImage（悬浮球自定义图片）
    if (typeof data.fabImage === 'string' && data.fabImage) {
        if (data.fabImage.startsWith(IMAGE_URL_PREFIX)) {
            const name = path.basename(data.fabImage);
            if (isValidImageName(name)) referenced.add(name);
        } else if (DATA_URL_RE.test(data.fabImage)) {
            const result = await storeBase64Image(data.fabImage);
            if (result) {
                data.fabImage = result.url;
                referenced.add(result.name);
            }
        }
    }

    return referenced;
}

// ── GC：收集引用 → 删除未引用文件 ───────────────────────
function collectReferences(data) {
    const referenced = new Set();
    const collect = (list) => {
        if (!Array.isArray(list)) return;
        for (const o of list) {
            if (!o || typeof o.imageData !== 'string') continue;
            if (o.imageData.startsWith(IMAGE_URL_PREFIX)) {
                const name = path.basename(o.imageData);
                if (isValidImageName(name)) referenced.add(name);
            }
        }
    };
    collect(data.outfits);
    if (data.chars) {
        for (const k of Object.keys(data.chars)) {
            collect((data.chars[k] || {}).outfits);
        }
    }
    if (Array.isArray(data.presets)) {
        for (const p of data.presets) collect((p || {}).outfits);
    }
    // fabImage
    if (typeof data.fabImage === 'string' && data.fabImage.startsWith(IMAGE_URL_PREFIX)) {
        const name = path.basename(data.fabImage);
        if (isValidImageName(name)) referenced.add(name);
    }
    return referenced;
}

async function gcImages(dryRun) {
    const data = (await readDataFile()) || {};
    const referenced = collectReferences(data);

    let files;
    try {
        files = await fsp.readdir(IMAGES_DIR);
    } catch (err) {
        if (err && err.code === 'ENOENT') return { removed: 0, kept: 0, candidates: [] };
        throw err;
    }

    const candidates = [];
    for (const f of files) {
        if (!isValidImageName(f)) continue;
        if (!referenced.has(f)) candidates.push(f);
    }

    if (!dryRun) {
        for (const f of candidates) {
            try { await fsp.unlink(path.join(IMAGES_DIR, f)); } catch { /* ignore */ }
        }
    }

    return {
        removed: dryRun ? 0 : candidates.length,
        kept: referenced.size,
        candidates: dryRun ? candidates : [],
        wouldRemove: dryRun ? candidates.length : undefined,
    };
}

// ── 路由初始化 ──────────────────────────────────────────
async function init(router) {
    // 路由必须同步注册（ST server plugin 要求）
    router.use(express.json({ limit: '64mb' }));

    // ─ GET /status ──────────────────────────────────────
    router.get('/status', (_req, res) => {
        res.json({ ok: true, version: 1, name: info.name });
    });

    // ─ GET /data ────────────────────────────────────────
    router.get('/data', async (_req, res) => {
        try {
            const data = await readDataFile();
            res.json({ ok: true, data: data || null });
        } catch (err) {
            console.error('[outfit-manager] GET /data failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to read data' });
        }
    });

    // ─ PUT /data ────────────────────────────────────────
    router.put('/data', async (req, res) => {
        try {
            const body = req.body;
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return res.status(400).json({ ok: false, error: 'Body must be a JSON object' });
            }
            await externalizeAllImages(body);
            await writeDataFile(body);
            res.json({ ok: true });
        } catch (err) {
            console.error('[outfit-manager] PUT /data failed:', err.message);
            // 首次迁移时 base64 数据可能很大，给出有意义的提示
            if (err.message && err.message.includes('PayloadTooLargeError')) {
                res.status(413).json({ ok: false, error: '数据过大，请尝试分批迁移或先清理后重试' });
            } else {
                res.status(500).json({ ok: false, error: 'Failed to write data' });
            }
        }
    });

    // ─ POST /images ─────────────────────────────────────
    // 单张上传：body = { dataUrl: "data:image/..." }
    router.post('/images', async (req, res) => {
        try {
            const { dataUrl } = req.body || {};
            if (typeof dataUrl !== 'string' || !dataUrl) {
                return res.status(400).json({ ok: false, error: 'Missing dataUrl field' });
            }
            const result = await storeBase64Image(dataUrl);
            if (!result) {
                return res.status(400).json({ ok: false, error: 'Invalid image format. Allowed: jpg/png/webp/gif/bmp' });
            }
            res.json({ ok: true, name: result.name, url: result.url });
        } catch (err) {
            console.error('[outfit-manager] POST /images failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to store image' });
        }
    });

    // ─ POST /images/batch-fetch ─────────────────────────
    // 批量取图片 base64（导出用）
    // body = { urls: ["/api/plugins/outfit-manager/images/xxx.jpg", ...] }
    // 安全约束：只接受本插件路径，不做开放代理
    router.post('/images/batch-fetch', async (req, res) => {
        try {
            const { urls } = req.body || {};
            if (!Array.isArray(urls)) {
                return res.status(400).json({ ok: false, error: 'urls must be an array' });
            }

            const results = {};
            for (const url of urls) {
                if (typeof url !== 'string') continue;
                // 安全校验：只接受本插件路径
                if (!url.startsWith(IMAGE_URL_PREFIX)) continue;
                const name = path.basename(url);
                if (!isValidImageName(name)) continue;
                // 去重：同名只读一次
                if (results[url]) continue;

                const dataUrl = await imageToDataUrl(name);
                if (dataUrl) {
                    results[url] = dataUrl;
                }
            }
            res.json({ ok: true, images: results });
        } catch (err) {
            console.error('[outfit-manager] POST /images/batch-fetch failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to fetch images' });
        }
    });

    // ─ GET /images/:name ────────────────────────────────
    router.get('/images/:name', (req, res) => {
        const name = path.basename(req.params.name || '');
        if (!isValidImageName(name)) {
            return res.status(400).json({ ok: false, error: 'Invalid image name' });
        }
        const filePath = path.join(IMAGES_DIR, name);
        // 二次路径穿越校验
        if (!filePath.startsWith(IMAGES_DIR + path.sep)) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        res.sendFile(filePath, (err) => {
            if (err) {
                if (err.code === 'ENOENT') res.status(404).json({ ok: false, error: 'Not found' });
                else { try { res.status(500).end(); } catch { /* noop */ } }
            }
        });
    });

    // ─ POST /gc ─────────────────────────────────────────
    // body = { dryRun: true } 时只返回将被清理的文件列表，不实际删除
    router.post('/gc', async (req, res) => {
        try {
            const dryRun = !!(req.body && req.body.dryRun);
            const result = await gcImages(dryRun);
            res.json({ ok: true, ...result });
        } catch (err) {
            console.error('[outfit-manager] POST /gc failed:', err.message);
            res.status(500).json({ ok: false, error: 'Failed to gc' });
        }
    });

    // 全局错误处理：友好提示 PayloadTooLarge 等异常
    router.use(function (err, _req, res, _next) {
        if (err.type === 'entity.too.large') {
            console.error('[outfit-manager] Request too large:', err.message);
            res.status(413).json({
                ok: false,
                error: '数据过大，请先导出备份/分批迁移/清理图片后重试'
            });
        } else {
            console.error('[outfit-manager] Unexpected error:', err.message);
            res.status(500).json({ ok: false, error: 'Internal server error' });
        }
    });

    // 路由注册完毕，执行异步初始化
    ensureDirsSync();
    console.log('[outfit-manager] Plugin loaded. Data dir: ' + DATA_DIR);
}

async function exit() {
    // 无需特殊清理
}

module.exports = { init, exit, info };
