
const CONFIG = {
    ARCHIVE_USERNAME: "Mikeboy58",
    MAX_VIDEOS: 100,
    META_CONCURRENCY: 3,
    THUMB_CONCURRENCY: 1,
    THUMB_SEEK_RATIO: 0.12,
    META_TTL: 1000 * 60 * 60 * 12,
    MAX_RETRIES: 3,
    RETRY_DELAYS: [1000, 2000, 4000],
    PROXY_URLS: ['https://corsproxy.io/?', 'https://api.allorigins.win/raw?url='],
    BUFFER_MIN_S: 5,
    BUFFER_MAX_S: 20,
    BUFFER_RATIO: 0.08,
    BUFFER_TIMEOUT_MS: 12000
};

const state = {
    allVideos: [], visible: [], currentIndex: -1, filter: 'all', query: '', focusIndex: -1,
    favorites: JSON.parse(localStorage.getItem('myFavorites') || '[]'),
    speeds: [0.5, 1, 1.25, 1.5, 2], speedIndex: 1,
    abLoop: { a: null, b: null, active: false },
    contextTarget: null, ready: false, wakeLock: null,
    autoThumb: localStorage.getItem('autoThumb') !== '0',
    watchedSeconds: 0, lastTick: null, retryCount: 0
};

const $ = id => document.getElementById(id);
const video = $('mainVideo');

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function encodePath(name) { return String(name).split('/').map(encodeURIComponent).join('/'); }
function fileUrl(identifier, name) {
    return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodePath(name)}`;
}
function formatTime(sec) {
    sec = Number(sec);
    if (!isFinite(sec) || sec < 0) return "0m 00s";
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return (h ? h + 'h ' : '') + m + 'm ' + String(s).padStart(2, '0') + 's';
}
function showToast(msg, duree = 3000) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.animation = 'slideDown .3s ease forwards'; setTimeout(() => t.remove(), 300); }, duree);
}
async function pool(items, limit, worker) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) { const idx = i++; try { out[idx] = await worker(items[idx], idx); } catch { out[idx] = null; } }
    }));
    return out;
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function placeholderFor(title) {
    let hash = 0;
    const str = String(title || '?');
    for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    const hue = hash % 360;
    const initials = (str.replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2)
        .map(w => w[0] || '').join('') || '?').toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},45%,22%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},55%,12%)"/>
</linearGradient></defs>
<rect width="320" height="180" fill="url(#g)"/>
<text x="160" y="105" font-family="sans-serif" font-size="56" font-weight="700" fill="hsl(${hue},60%,70%)" text-anchor="middle" opacity=".85">${escapeHtml(initials)}</text>
<text x="160" y="150" font-family="sans-serif" font-size="13" fill="#ffffff" text-anchor="middle" opacity=".35">aperçu indisponible</text>
</svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function versLienStable(url) {
    const m = String(url).match(/\/(?:items|download)\/([^/?#]+)\/(.+)$/);
    return m ? `https://archive.org/download/${m[1]}/${m[2]}` : null;
}

/* ---------- Indicateur compact ---------- */
function afficherChargement(texte, detail = '', retry = '') {
    const pill = $('loadPill'), bar = $('loadBar'), tip = $('loadTip');
    if (!pill) return;
    bar.classList.add('active');
    pill.classList.add('active');
    pill.classList.remove('err');
    const m = String(retry).match(/(\d+)\s*\/\s*(\d+)/);
    $('loadPillText').textContent = m ? `essai ${m[1]}/${m[2]}` : 'chargement…';
    tip.innerHTML = `<b>${escapeHtml(texte)}</b>` +
        (detail ? `<br>${escapeHtml(detail)}` : '') +
        (retry ? `<br>${escapeHtml(retry)}` : '');
    pill.title = texte + (detail ? ' — ' + detail : '');
}
function afficherTampon(buf, target) {
    const pill = $('loadPill'), bar = $('loadBar');
    if (!pill) return;
    bar.classList.add('active');
    pill.classList.add('active');
    pill.classList.remove('err');
    $('loadPillText').textContent = `tampon ${Math.floor(buf)}s/${Math.floor(target)}s`;
}
function masquerChargement() {
    $('loadBar')?.classList.remove('active');
    $('loadPill')?.classList.remove('active', 'err');
    $('loadTip')?.classList.remove('active');
}
function chargementErreur(msg) {
    const pill = $('loadPill');
    if (!pill) return;
    $('loadBar').classList.remove('active');
    pill.classList.add('active', 'err');
    $('loadPillText').textContent = 'erreur';
    $('loadTip').innerHTML = `<b>❌ ${escapeHtml(msg)}</b>`;
    setTimeout(masquerChargement, 4000);
}

/* ---------- Buffer anti-saccades ---------- */
function bufferedAhead() {
    try {
        for (let i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
                return video.buffered.end(i) - video.currentTime;
            }
        }
    } catch {}
    return 0;
}
function attendreBufferAvantLecture() {
    return new Promise(resolve => {
        if (!isFinite(video.duration) || video.duration <= 0) { masquerChargement(); return resolve(); }
        const target = Math.max(CONFIG.BUFFER_MIN_S, Math.min(CONFIG.BUFFER_MAX_S, video.duration * CONFIG.BUFFER_RATIO));
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            video.removeEventListener('progress', check);
            video.removeEventListener('canplay', check);
            clearTimeout(timeout);
            masquerChargement();
            resolve();
        };
        const check = () => {
            const buf = bufferedAhead();
            if (buf >= target || video.readyState >= 4) finish();
            else afficherTampon(buf, target);
        };
        const timeout = setTimeout(finish, CONFIG.BUFFER_TIMEOUT_MS);
        video.addEventListener('progress', check);
        video.addEventListener('canplay', check);
        check();
    });
}

/* ---------- Retry + fallback ---------- */
async function testerURL(url, timeout = 5000) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        const response = await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-cache', signal: controller.signal });
        clearTimeout(timeoutId);
        return response.ok || response.type === 'opaque';
    } catch (e) { return false; }
}
function genererURLsFallback(urlBase) {
    const urls = [];
    const stable = versLienStable(urlBase);
    if (stable) urls.push({ url: stable, type: 'stable', priority: 1 });
    urls.push({ url: urlBase, type: 'direct', priority: 2 });
    CONFIG.PROXY_URLS.forEach((proxy, i) => {
        urls.push({ url: proxy + encodeURIComponent(stable || urlBase), type: 'proxy', priority: 3 + i });
    });
    return urls.sort((a, b) => a.priority - b.priority);
}
async function chargerVideoAvecRetry(urls, index = 0) {
    if (index >= urls.length) {
        chargementErreur('Vidéo injoignable (serveur Archive.org indisponible ou CORS)');
        return false;
    }
    const { url, type } = urls[index];
    const attempt = state.retryCount + 1;
    let typeText = 'URL stable';
    if (type === 'direct') typeText = 'Serveur direct';
    if (type === 'proxy') typeText = 'Proxy CORS';

    afficherChargement('Chargement de la vidéo...', `Méthode ${index + 1}/${urls.length} : ${typeText}`, `Tentative ${attempt}/${CONFIG.MAX_RETRIES}`);

    try {
        if (type === 'direct') {
            const accessible = await testerURL(url, 3000);
            if (!accessible) {
                state.retryCount = 0;
                return chargerVideoAvecRetry(urls, index + 1);
            }
        }
        return new Promise((resolve) => {
            const onLoadStart = () => afficherChargement('Connexion établie !', `Via ${typeText}`, 'Chargement des métadonnées...');
            const onLoadedMetadata = () => {
                video.removeEventListener('loadstart', onLoadStart);
                video.removeEventListener('loadedmetadata', onLoadedMetadata);
                video.removeEventListener('error', onError);
                resolve(true);
            };
            const onError = () => {
                video.removeEventListener('loadstart', onLoadStart);
                video.removeEventListener('loadedmetadata', onLoadedMetadata);
                video.removeEventListener('error', onError);
                const err = video.error;
                if (err && err.code === MediaError.MEDIA_ERR_ABORTED) { resolve(false); return; }
                let errorType = 'inconnue';
                if (err) {
                    errorType = {
                        [MediaError.MEDIA_ERR_NETWORK]: 'réseau (403/404)',
                        [MediaError.MEDIA_ERR_DECODE]: 'codec non supporté',
                        [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: 'fichier introuvable ou CORS'
                    }[err.code] || 'inconnue';
                }
                if (state.retryCount < CONFIG.MAX_RETRIES) {
                    state.retryCount++;
                    const delay = CONFIG.RETRY_DELAYS[state.retryCount - 1] || 2000;
                    afficherChargement(`Erreur ${errorType}`, `Nouvelle tentative dans ${delay / 1000}s...`, `Tentative ${attempt + 1}/${CONFIG.MAX_RETRIES}`);
                    setTimeout(() => chargerVideoAvecRetry(urls, index).then(resolve), delay);
                } else {
                    state.retryCount = 0;
                    chargerVideoAvecRetry(urls, index + 1).then(resolve);
                }
            };
            video.addEventListener('loadstart', onLoadStart);
            video.addEventListener('loadedmetadata', onLoadedMetadata);
            video.addEventListener('error', onError);
            video.src = url;
            video.load();
        });
    } catch (e) {
        state.retryCount = 0;
        return chargerVideoAvecRetry(urls, index + 1);
    }
}

/* ---------- IndexedDB (vignettes + méta) ---------- */
const Cache = (() => {
    let dbp = null;
    function open() {
        if (dbp) return dbp;
        dbp = new Promise((res, rej) => {
            if (!('indexedDB' in window)) return rej(new Error('no idb'));
            const r = indexedDB.open('rainbow-cinema', 1);
            r.onupgradeneeded = () => {
                const db = r.result;
                if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs');
                if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
            };
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
        return dbp;
    }
    async function get(store, key) {
        try {
            const db = await open();
            return await new Promise((res, rej) => {
                const rq = db.transaction(store, 'readonly').objectStore(store).get(key);
                rq.onsuccess = () => res(rq.result ?? null);
                rq.onerror = () => rej(rq.error);
            });
        } catch { return null; }
    }
    async function set(store, key, val) {
        try {
            const db = await open();
            await new Promise((res, rej) => {
                const tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).put(val, key);
                tx.oncomplete = res; tx.onerror = () => rej(tx.error);
            });
        } catch {}
    }
    async function clear(store) {
        try {
            const db = await open();
            await new Promise(res => {
                const tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).clear();
                tx.oncomplete = res; tx.onerror = res;
            });
        } catch {}
    }
    async function count(store) {
        try {
            const db = await open();
            return await new Promise(res => {
                const rq = db.transaction(store, 'readonly').objectStore(store).count();
                rq.onsuccess = () => res(rq.result); rq.onerror = () => res(0);
            });
        } catch { return 0; }
    }
    return { get, set, clear, count };
})();

function getProgress(url) {
    const raw = localStorage.getItem('progress_' + url);
    if (!raw) return null;
    try { if (raw.trim().startsWith('{')) { const o = JSON.parse(raw); return { t: +o.t || 0, d: +o.d || 0 }; } } catch {}
    return { t: parseFloat(raw) || 0, d: 0 };
}
function setProgress(url, t, d) {
    try { localStorage.setItem('progress_' + url, JSON.stringify({ t: Math.floor(t), d: Math.floor(d || 0) })); } catch {}
}
function progressPercent(url) {
    const p = getProgress(url);
    if (!p || !p.d || p.t < 5) return 0;
    return Math.min(100, Math.round((p.t / p.d) * 100));
}

function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    showToast(next === 'light' ? '☀️ Mode clair' : '🌙 Mode sombre');
}
function changeColor(color, el) {
    document.documentElement.style.setProperty('--primary', color);
    document.documentElement.style.setProperty('--primary-glow', color + '66');
    document.querySelectorAll('.color-option').forEach(e => e.classList.remove('active'));
    if (el) el.classList.add('active');
    localStorage.setItem('primaryColor', color);
    showToast('🎨 Couleur modifiée');
}
(function initTheme() {
    const t = localStorage.getItem('theme'); if (t) document.documentElement.setAttribute('data-theme', t);
    const c = localStorage.getItem('primaryColor');
    if (c) {
        document.documentElement.style.setProperty('--primary', c);
        document.documentElement.style.setProperty('--primary-glow', c + '66');
        document.querySelectorAll('.color-option').forEach(e => {
            e.classList.toggle('active', e.getAttribute('style').includes(c));
        });
    }
})();

function openSettings() { $('settingsModal').classList.add('active'); majInfoCache(); }
function closeSettings() { $('settingsModal').classList.remove('active'); }
$('settingsModal').addEventListener('click', e => { if (e.target.id === 'settingsModal') closeSettings(); });
function toggleAutoThumb(on) {
    state.autoThumb = on;
    localStorage.setItem('autoThumb', on ? '1' : '0');
    showToast(on ? '🖼️ Génération auto activée' : 'Génération auto désactivée');
}
async function majInfoCache() {
    const n = await Cache.count('thumbs');
    $('thumbCacheInfo').textContent = `Cache : ${n} vignette(s) en mémoire locale`;
}
async function viderCacheVignettes() {
    await Cache.clear('thumbs');
    showToast('🗑️ Cache vignettes vidé');
    majInfoCache();
    renderGrid();
}
function exportData() {
    const data = {
        favorites: state.favorites,
        stats: JSON.parse(localStorage.getItem('viewingStats') || '{}'),
        progress: {}, notes: {},
        radio: { custom: Radio.custom, current: Radio.current, volumes: { radio: $('radioVolume').value, mix: $('videoMixVolume').value } }
    };
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('progress_')) data.progress[k] = localStorage.getItem(k);
        if (k?.startsWith('notes_')) data.notes[k] = localStorage.getItem(k);
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backup-rainbow-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast('📤 Données exportées');
}
function importData(e) {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = ev => {
        try {
            const d = JSON.parse(ev.target.result);
            if (d.favorites) { state.favorites = d.favorites; localStorage.setItem('myFavorites', JSON.stringify(d.favorites)); }
            if (d.stats) localStorage.setItem('viewingStats', JSON.stringify(d.stats));
            if (d.progress) Object.entries(d.progress).forEach(([k, v]) => localStorage.setItem(k, v));
            if (d.notes) Object.entries(d.notes).forEach(([k, v]) => localStorage.setItem(k, v));
            if (d.radio?.custom) { Radio.custom = d.radio.custom; localStorage.setItem('radioCustom', JSON.stringify(d.radio.custom)); }
            showToast('📥 Données importées');
            renderGrid(); genererContinueWatching(); afficherStats(); renderStations();
        } catch { showToast('❌ Fichier invalide'); }
    };
    r.readAsText(file);
    e.target.value = '';
}
function resetAllData() {
    if (!confirm('⚠️ Effacer TOUTES les données (favoris, progression, notes, stats, radio) ?')) return;
    localStorage.clear();
    Cache.clear('thumbs'); Cache.clear('meta');
    showToast('🗑️ Données effacées');
    setTimeout(() => location.reload(), 600);
}

const Radio = {
    stations: [
        { nom: 'ibizasonica', url: 'https://ibizasonica.streaming-pro.com:8000/ibizasonica', genre: 'Généraliste' },
        { nom: 'Ibiza Global', url: 'http://ibizaglobalradio.streaming-pro.com:8024/', genre: 'Info' },
        { nom: 'Pure Ibiza', url: 'http://control.streaming-pro.com:8024/stream.aac', genre: 'Éclectique' },
        { nom: 'ROCK FM Guns N rose', url: 'http://streams.regenbogen.de/rr-gunsnroses-128-mp3', genre: 'Classique' },
        { nom: 'Guns N Roses', url: 'https://stream02.pcradio.biz/guns_n_roses-hi', genre: 'Jazz' }
    ],
    custom: JSON.parse(localStorage.getItem('radioCustom') || '[]'),
    current: JSON.parse(localStorage.getItem('radioCurrent') || 'null'),
    on: false, sleepTimeout: null, prevVideoVolume: 1
};
function toggleRadioPanel() {
    const p = $('radioPanel');
    p.classList.toggle('open');
    if (p.classList.contains('open')) renderStations();
}
function renderStations() {
    const box = $('radioStations');
    box.innerHTML = '';
    [...Radio.stations, ...Radio.custom].forEach((s, i) => {
        const chip = document.createElement('button');
        chip.className = 'station-chip' + (Radio.current?.url === s.url ? ' active' : '');
        const name = document.createElement('span');
        name.textContent = s.nom;
        const genre = document.createElement('span');
        genre.className = 'station-genre';
        genre.textContent = s.genre || '';
        chip.append(name, genre);
        chip.addEventListener('click', () => selectStation(s));
        if (i >= Radio.stations.length) {
            const del = document.createElement('span');
            del.className = 'station-del';
            del.textContent = '✕';
            del.addEventListener('click', e => { e.stopPropagation(); removeCustomStation(i - Radio.stations.length); });
            chip.appendChild(del);
        }
        box.appendChild(chip);
    });
}
function selectStation(station) {
    Radio.current = station;
    localStorage.setItem('radioCurrent', JSON.stringify(station));
    $('radioNow').textContent = '📻 ' + station.nom;
    renderStations();
    startRadio();
}
async function startRadio() {
    const player = $('radioPlayer');
    if (!Radio.current) { showToast('⚠️ Choisissez une station'); return; }
    if (player.src !== Radio.current.url) player.src = Radio.current.url;
    player.volume = $('radioVolume').value / 100;
    $('radioNow').textContent = '⏳ Connexion à ' + Radio.current.nom + '…';
    try {
        await player.play();
        Radio.on = true; activerModeRadio(); majRadioUI();
        showToast(`📻 ${Radio.current.nom} — vidéo en sourdine`);
    } catch { Radio.on = false; majRadioUI(); showToast('❌ Impossible de lire cette station'); }
}
function stopRadio(silent) {
    const player = $('radioPlayer');
    player.pause(); player.removeAttribute('src'); player.load();
    Radio.on = false; desactiverModeRadio();
    clearTimeout(Radio.sleepTimeout);
    $('sleepTimer').value = '0';
    majRadioUI();
    if (!silent) showToast('📻 Radio arrêtée — son vidéo restauré');
}
function toggleRadio() { Radio.on ? stopRadio() : startRadio(); }
function activerModeRadio() {
    Radio.prevVideoVolume = video.volume;
    video.volume = $('videoMixVolume').value / 100;
    localStorage.setItem('radioMode', '1');
}
function desactiverModeRadio() {
    video.volume = Radio.prevVideoVolume || 1;
    localStorage.setItem('radioMode', '0');
}
function appliquerMixRadio() {
    if (localStorage.getItem('radioMode') === '1') video.volume = ($('videoMixVolume').value || 0) / 100;
}
function majRadioUI() {
    $('radioBtn').classList.toggle('radio-active', Radio.on);
    $('radioPower').textContent = Radio.on ? '⏸ Arrêter' : '▶ Écouter';
    $('radioEq').classList.toggle('on', Radio.on);
    if (!Radio.on && Radio.current) $('radioNow').textContent = '⏸ ' + Radio.current.nom + ' (en pause)';
    if (!Radio.on && !Radio.current) $('radioNow').textContent = 'Choisissez une station';
}
function setRadioVolume(v) { $('radioPlayer').volume = v / 100; localStorage.setItem('radioVolume', v); }
function setVideoMixVolume(v) {
    localStorage.setItem('videoMixVolume', v);
    if (localStorage.getItem('radioMode') === '1') video.volume = v / 100;
}
function setSleepTimer(min) {
    clearTimeout(Radio.sleepTimeout);
    min = parseInt(min);
    if (!min) return;
    Radio.sleepTimeout = setTimeout(() => { stopRadio(true); showToast('😴 Radio arrêtée (minuteur)'); }, min * 60000);
    showToast(`😴 La radio s'arrêtera dans ${min} min`);
}
function playCustomStation() {
    const input = $('radioCustomUrl');
    const url = input.value.trim();
    if (!/^https?:\/\/.+/.test(url)) { showToast('⚠️ URL invalide'); return; }
    let station = Radio.custom.find(s => s.url === url);
    if (!station) {
        const defaut = (url.split('/').filter(Boolean).pop() || 'Ma radio').slice(0, 40);
        const nom = prompt('Nom de la station :', defaut);
        if (nom === null) return;
        station = { nom: nom.trim() || defaut, url, genre: 'perso' };
        Radio.custom.push(station);
        localStorage.setItem('radioCustom', JSON.stringify(Radio.custom));
        showToast('✅ Station ajoutée');
    }
    input.value = '';
    selectStation(station);
}
function removeCustomStation(i) {
    Radio.custom.splice(i, 1);
    localStorage.setItem('radioCustom', JSON.stringify(Radio.custom));
    renderStations();
    showToast('🗑️ Station retirée');
}
function initRadio() {
    const rv = localStorage.getItem('radioVolume'); if (rv) $('radioVolume').value = rv;
    const mv = localStorage.getItem('videoMixVolume'); if (mv) $('videoMixVolume').value = mv;
    $('autoThumbSwitch').checked = state.autoThumb;
    if (Radio.current) $('radioNow').textContent = '⏸ ' + Radio.current.nom;
    renderStations();
    if (localStorage.getItem('radioMode') === '1') {
        showToast('📻 Mode radio actif — cliquez sur Écouter pour démarrer', 4500);
        video.volume = ($('videoMixVolume').value || 0) / 100;
    }
    const player = $('radioPlayer');
    player.addEventListener('playing', () => { if (Radio.current) $('radioNow').textContent = '📻 ' + Radio.current.nom; });
    player.addEventListener('stalled', () => { if (Radio.on) $('radioNow').textContent = '⏳ Reconnexion…'; });
    player.addEventListener('error', () => { if (Radio.on) { showToast('❌ Flux radio interrompu'); stopRadio(true); } });
}

function startVoiceSearch() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showToast('❌ Recherche vocale non supportée'); return; }
    const rec = new SR();
    rec.lang = 'fr-FR'; rec.continuous = false; rec.interimResults = false;
    const btn = $('voiceBtn');
    btn.classList.add('listening');
    rec.onresult = ev => {
        $('searchInput').value = ev.results[0][0].transcript;
        state.query = ev.results[0][0].transcript.toLowerCase();
        renderGrid();
    };
    rec.onerror = () => showToast('❌ Micro indisponible');
    rec.onend = () => btn.classList.remove('listening');
    try { rec.start(); } catch { btn.classList.remove('listening'); }
}

function lireStats() { return JSON.parse(localStorage.getItem('viewingStats') || '{"totalTime":0,"videosWatched":0,"dailyStats":{}}'); }
function flushStats() {
    if (state.watchedSeconds < 1) return;
    const s = lireStats();
    s.totalTime = (s.totalTime || 0) + state.watchedSeconds;
    const today = new Date().toISOString().split('T')[0];
    s.dailyStats = s.dailyStats || {};
    s.dailyStats[today] = (s.dailyStats[today] || 0) + state.watchedSeconds;
    localStorage.setItem('viewingStats', JSON.stringify(s));
    state.watchedSeconds = 0;
    afficherStats();
}
function compterVideoVue() {
    const s = lireStats();
    s.videosWatched = (s.videosWatched || 0) + 1;
    localStorage.setItem('viewingStats', JSON.stringify(s));
    afficherStats();
}
function afficherStats() {
    const s = lireStats();
    const h = Math.floor((s.totalTime || 0) / 3600), m = Math.floor(((s.totalTime || 0) % 3600) / 60);
    $('statsDisplay').textContent = `📊 ${s.videosWatched || 0} vidéos (${h}h ${m}min)`;
}
function showStats() {
    const s = lireStats();
    const h = Math.floor((s.totalTime || 0) / 3600), m = Math.floor(((s.totalTime || 0) % 3600) / 60);
    const top = Object.entries(s.dailyStats || {}).sort((a, b) => b[1] - a[1])[0];
    alert(`📊 Statistiques\n\n📺 ${s.videosWatched || 0} vidéos terminées\n⏱️ ${h}h ${m}min réellement visionnées\n📅 ${Object.keys(s.dailyStats || {}).length} jours d'activité` +
        (top ? `\n🔥 Meilleur jour : ${top[0]} (${Math.round(top[1] / 60)} min)` : ''));
}

function toggleFavorite(url, ev) {
    if (ev) ev.stopPropagation();
    const i = state.favorites.indexOf(url);
    if (i === -1) { state.favorites.push(url); showToast('❤️ Ajouté aux favoris'); }
    else { state.favorites.splice(i, 1); showToast('💔 Retiré des favoris'); }
    localStorage.setItem('myFavorites', JSON.stringify(state.favorites));
    document.querySelectorAll('.fav-btn').forEach(b => {
        if (b.dataset.url === url) {
            const fav = state.favorites.includes(url);
            b.classList.toggle('is-fav', fav);
            b.textContent = fav ? '❤️' : '🤍';
        }
    });
    if (state.filter === 'favorites') renderGrid();
}

function choisirFichierVideo(files) {
    const mp4 = files.filter(f => f.name && /\.mp4$/i.test(f.name));
    if (!mp4.length) return null;
    const score = f => {
        const fmt = (f.format || '').toLowerCase();
        let s = 0;
        if (fmt.includes('h.264') || fmt === 'mpeg4') s += 100;
        if (f.source === 'original') s += 50;
        if (/\.ia\.mp4$/i.test(f.name)) s += 10;
        return s;
    };
    mp4.sort((a, b) => (score(b) - score(a)) || ((parseInt(b.size) || 0) - (parseInt(a.size) || 0)));
    return mp4[0];
}
function choisirVignette(files, identifier, videoName) {
    const base = videoName.replace(/\.[^.]+$/, '');
    const isImg = f => /\.(png|jpe?g)$/i.test(f.name || '');
    const isThumb = f => /thumb/i.test(f.format || '') || /thumb/i.test(f.name || '');
    let t = files.find(f => isImg(f) && f.original && f.original === videoName && isThumb(f));
    if (t) return { url: fileUrl(identifier, t.name), kind: 'file' };
    t = files.find(f => isImg(f) && isThumb(f) && (f.name.includes(base + '.') || f.name.includes(base + '/')));
    if (t) return { url: fileUrl(identifier, t.name), kind: 'file' };
    const thumbs = files.filter(f => isImg(f) && isThumb(f) && f.source === 'derivative');
    if (thumbs.length) {
        const mid = thumbs[Math.floor(thumbs.length / 2)];
        return { url: fileUrl(identifier, mid.name), kind: 'item' };
    }
    if (files.some(f => f.name === '__ia_thumb.jpg'))
        return { url: fileUrl(identifier, '__ia_thumb.jpg'), kind: 'item' };
    return { url: `https://archive.org/services/img/${encodeURIComponent(identifier)}`, kind: 'item' };
}
async function fetchMeta(identifier) {
    const cached = await Cache.get('meta', identifier);
    if (cached && Date.now() - cached.ts < CONFIG.META_TTL) return cached.data;
    const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
    if (!res.ok) throw new Error('meta ' + res.status);
    const data = await res.json();
    await Cache.set('meta', identifier, { ts: Date.now(), data });
    return data;
}
function extraireIdentifier(url) {
    const m = String(url).match(/\/(?:items|download|embed|details)\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
}
async function chargerToutesLesVideos() {
    const combined = [];
    try {
        const res = await fetch('videos.json', { cache: 'no-cache' });
        if (res.ok) {
            const list = await res.json();
            (Array.isArray(list) ? list : []).forEach(v => {
                if (!v.video) return;
                const customThumb = v.vignette || v.image || null;
                combined.push({
                    titre: v.titre || v.video.split('/').pop(),
                    video: v.video,
                    vignette: customThumb,
                    thumbKind: customThumb ? 'custom' : 'none',
                    skipAutoThumb: !!customThumb,
                    identifier: extraireIdentifier(v.video),
                    source: 'json'
                });
            });
        }
    } catch {}
    try {
        const api = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`uploader:"${CONFIG.ARCHIVE_USERNAME}" AND mediatype:(movies)`)}&fl[]=identifier&fl[]=title&fl[]=publicdate&sort[]=-publicdate&output=json&rows=${CONFIG.MAX_VIDEOS}`;
        const r = await fetch(api);
        const j = await r.json();
        const docs = j?.response?.docs || [];
        const results = await pool(docs, CONFIG.META_CONCURRENCY, async doc => {
            try {
                const meta = await fetchMeta(doc.identifier);
                const files = meta.files || [];
                const f = choisirFichierVideo(files);
                if (!f) return null;
                const th = choisirVignette(files, doc.identifier, f.name);
                return {
                    titre: doc.title || meta.metadata?.title || doc.identifier,
                    video: fileUrl(doc.identifier, f.name),
                    vignette: th.url, thumbKind: th.kind, identifier: doc.identifier,
                    fileName: f.name, duration: parseFloat(f.length) || 0,
                    source: 'archive', date: doc.publicdate
                };
            } catch { return null; }
        });
        results.filter(Boolean).forEach(v => combined.push(v));
    } catch (e) { console.warn('Archive.org indisponible :', e); }
    const map = new Map();
    combined.forEach(v => { if (!map.has(v.video)) map.set(v.video, v); });
    state.allVideos = [...map.values()].sort((a, b) => {
        if (a.date && b.date) return new Date(b.date) - new Date(a.date);
        return 0;
    });
    if (!state.allVideos.length) {
        $('videoGrid').innerHTML = '<div class="error-state">❌ Aucune vidéo trouvée.<br><small>Vérifiez le nom d\'utilisateur Archive.org ou votre fichier videos.json</small></div>';
        $('mainTitle').textContent = 'Bibliothèque vide';
        return;
    }
    renderGrid();
    genererContinueWatching();
    afficherStats();
    if (new URLSearchParams(location.search).get('v')) chargerVideoDepuisURL();
    else restaurerSession();
}

const thumbQueue = [];
let thumbRunning = 0;
function enqueueThumb(videoObj, imgEl, flagEl) {
    if (videoObj.thumbKind === 'custom' || videoObj.skipAutoThumb) return;
    if (!state.autoThumb) return;
    if (navigator.connection?.saveData) return;
    if (!state.ready) return;
    thumbQueue.push({ videoObj, imgEl, flagEl });
    pumpThumbQueue();
}
function pumpThumbQueue() {
    if (!state.ready) return;
    while (thumbRunning < CONFIG.THUMB_CONCURRENCY && thumbQueue.length) {
        const job = thumbQueue.shift();
        thumbRunning++;
        (async () => {
            try {
                const key = job.videoObj.video;
                let data = await Cache.get('thumbs', key);
                if (!data) {
                    data = await captureFrame(job.videoObj.video, job.videoObj.duration);
                    if (data) await Cache.set('thumbs', key, data);
                }
                if (data && job.imgEl.isConnected) {
                    job.imgEl.src = data;
                    job.videoObj.vignette = data;
                    job.videoObj.thumbKind = 'auto';
                    if (job.flagEl) job.flagEl.textContent = '🖼️ auto';
                    if (state.allVideos[state.currentIndex] === job.videoObj) video.poster = data;
                } else if (!data && job.videoObj.identifier && job.imgEl.isConnected) {
                    job.imgEl.src = `https://archive.org/services/img/${encodeURIComponent(job.videoObj.identifier)}`;
                    if (job.flagEl) job.flagEl.textContent = '🖼️ item';
                }
            } catch {}
            thumbRunning--;
            pumpThumbQueue();
        })();
    }
}
function captureFrame(url, knownDuration) {
    return new Promise(resolve => {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.preload = 'metadata';
        v.muted = true;
        v.playsInline = true;
        let settled = false;
        const finish = val => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
            resolve(val);
        };
        const timer = setTimeout(() => finish(null), 20000);
        v.addEventListener('error', () => finish(null));
        v.addEventListener('loadedmetadata', () => {
            const d = isFinite(v.duration) && v.duration > 0 ? v.duration : (knownDuration || 0);
            let target = d ? Math.max(3, d * CONFIG.THUMB_SEEK_RATIO) : 5;
            if (d) target = Math.min(target, Math.max(0.5, d - 1));
            try { v.currentTime = target; } catch { finish(null); }
        });
        v.addEventListener('seeked', () => {
            try {
                const w = 320, h = Math.round(320 * (v.videoHeight / v.videoWidth)) || 180;
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                const ctx = c.getContext('2d');
                ctx.drawImage(v, 0, 0, w, h);
                const sample = ctx.getImageData(0, 0, w, h).data;
                let min = 255, max = 0;
                for (let i = 0; i < sample.length; i += 4 * 97) {
                    const l = (sample[i] + sample[i + 1] + sample[i + 2]) / 3;
                    if (l < min) min = l; if (l > max) max = l;
                }
                if (max - min < 12 && !v.dataset.retried && isFinite(v.duration) && v.duration > 20) {
                    v.dataset.retried = '1';
                    v.currentTime = v.duration * 0.45;
                    return;
                }
                finish(c.toDataURL('image/jpeg', 0.72));
            } catch { finish(null); }
        });
        v.src = url;
    });
}

const lazyObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const img = entry.target;
        lazyObserver.unobserve(img);
        const idx = +img.dataset.index;
        const v = state.allVideos[idx];
        if (!v) return;
        const flag = img.parentElement.querySelector('.thumb-flag');
        if (v.thumbKind === 'custom' && v.vignette) {
            img.src = v.vignette;
            img.addEventListener('error', () => {
                if (img.dataset.failed === '1') return;
                img.dataset.failed = '1';
                img.src = placeholderFor(v.titre);
            }, { once: true });
            return;
        }
        if (img.dataset.pending === '1') img.src = v.vignette;
        img.addEventListener('error', async () => {
            if (img.dataset.failed === '1') return;
            img.dataset.failed = '1';
            const cached = await Cache.get('thumbs', v.video);
            if (cached) { img.src = cached; v.vignette = cached; return; }
            img.src = placeholderFor(v.titre);
            enqueueThumb(v, img, flag);
        }, { once: true });
        if (v.thumbKind === 'item' && state.autoThumb) {
            Cache.get('thumbs', v.video).then(cached => {
                if (cached) { img.src = cached; v.vignette = cached; v.thumbKind = 'auto'; if (flag) flag.textContent = '🖼️ auto'; }
                else enqueueThumb(v, img, flag);
            });
        }
    });
}, { rootMargin: '300px' });

function computeVisible() {
    let list = state.allVideos;
    if (state.filter === 'favorites') list = list.filter(v => state.favorites.includes(v.video));
    if (state.filter === 'unwatched') list = list.filter(v => progressPercent(v.video) < 90);
    if (state.query) list = list.filter(v => v.titre.toLowerCase().includes(state.query));
    return list;
}
function renderGrid() {
    const grid = $('videoGrid');
    state.visible = computeVisible();
    grid.innerHTML = '';
    $('libraryCount').textContent = `📁 Bibliothèque — ${state.visible.length} / ${state.allVideos.length}`;
    if (!state.visible.length) { grid.innerHTML = '<div class="empty-state">Aucun résultat.</div>'; return; }
    const frag = document.createDocumentFragment();
    state.visible.forEach(v => {
        const index = state.allVideos.indexOf(v);
        const pct = progressPercent(v.video);
        const isFav = state.favorites.includes(v.video);
        const item = document.createElement('div');
        item.className = 'video-item' + (index === state.currentIndex ? ' active' : '');
        item.dataset.index = index;
        item.tabIndex = 0;
        const wrap = document.createElement('div');
        wrap.className = 'thumb-wrap';
        const img = document.createElement('img');
        img.loading = 'lazy'; img.decoding = 'async';
        img.alt = v.titre;
        img.dataset.index = index;
        img.src = placeholderFor(v.titre);
        if (v.vignette) img.dataset.pending = '1';
        const flag = document.createElement('span');
        flag.className = 'thumb-flag';
        let flagText = '🖼️ item';
        if (v.thumbKind === 'custom') flagText = '🎨 custom';
        else if (v.thumbKind === 'file') flagText = '🖼️ fichier';
        else if (v.thumbKind === 'auto') flagText = '🖼️ auto';
        flag.textContent = flagText;
        const fav = document.createElement('button');
        fav.className = 'fav-btn' + (isFav ? ' is-fav' : '');
        fav.dataset.url = v.video;
        fav.textContent = isFav ? '❤️' : '🤍';
        fav.title = 'Favori';
        fav.addEventListener('click', e => toggleFavorite(v.video, e));
        const bar = document.createElement('div');
        bar.className = 'progress-bar';
        bar.style.width = pct + '%';
        wrap.append(img, flag, fav, bar);
        const title = document.createElement('div');
        title.className = 'title';
        title.textContent = v.titre;
        title.title = v.titre;
        item.append(wrap, title);
        item.addEventListener('click', () => jouerVideo(index));
        item.addEventListener('keydown', e => { if (e.key === 'Enter') jouerVideo(index); });
        item.addEventListener('contextmenu', e => {
            e.preventDefault();
            state.contextTarget = v;
            const menu = $('contextMenu');
            menu.style.display = 'block';
            menu.style.left = Math.min(e.pageX, window.innerWidth - 210) + 'px';
            menu.style.top = e.pageY + 'px';
        });
        frag.appendChild(item);
        lazyObserver.observe(img);
    });
    grid.appendChild(frag);
}
function updateActiveStates() {
    document.querySelectorAll('.video-item').forEach(el => {
        el.classList.toggle('active', +el.dataset.index === state.currentIndex);
    });
}
function filtrer(type, btn) {
    state.filter = type;
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    (btn || document.querySelector(`.filter-tab[data-filter="${type}"]`))?.classList.add('active');
    state.focusIndex = -1;
    renderGrid();
}
function genererContinueWatching() {
    const section = $('continueSection'), scroll = $('continueScroll');
    scroll.innerHTML = '';
    const items = state.allVideos
        .map(v => ({ v, p: getProgress(v.video) }))
        .filter(x => x.p && x.p.t > 10 && progressPercent(x.v.video) < 95)
        .slice(0, 15);
    items.forEach(({ v }) => {
        const pct = progressPercent(v.video);
        const div = document.createElement('div');
        div.className = 'hw-item';
        const img = document.createElement('img');
        img.src = v.vignette || placeholderFor(v.titre);
        img.alt = v.titre;
        img.onerror = () => { img.src = placeholderFor(v.titre); };
        const bar = document.createElement('div');
        bar.className = 'hw-progress';
        bar.style.width = pct + '%';
        const t = document.createElement('div');
        t.className = 'hw-title';
        t.textContent = v.titre;
        div.append(img, bar, t);
        div.onclick = () => jouerVideo(state.allVideos.indexOf(v));
        scroll.appendChild(div);
    });
    section.classList.toggle('visible', items.length > 0);
}

function jouerVideo(index, options = {}) {
    if (index < 0 || index >= state.allVideos.length) return;
    flushStats();
    state.currentIndex = index;
    state.ready = false;
    state.abLoop = { a: null, b: null, active: false };
    state.retryCount = 0;
    const v = state.allVideos[index];
    const resume = options.startTime ?? (getProgress(v.video)?.t || 0);
    $('mainTitle').textContent = v.titre;
    const amb = $('ambilightBg');
    if (v.vignette) { amb.style.backgroundImage = `url("${v.vignette}")`; amb.classList.add('active'); }
    video.poster = v.vignette || placeholderFor(v.titre);
    const badge = $('resumeBadge');
    if (resume > 5 && !options.startTime) {
        badge.style.display = 'inline-block';
        badge.textContent = `▶ Reprise à ${formatTime(resume)}`;
        setTimeout(() => badge.style.display = 'none', 6000);
    } else badge.style.display = 'none';

    const onMeta = () => {
        if (resume > 5 && isFinite(video.duration) && resume < video.duration - 3) {
            try { video.currentTime = resume; } catch {}
        }
        video.playbackRate = state.speeds[state.speedIndex];
        appliquerMixRadio();
        state.ready = true;
        attendreBufferAvantLecture().then(() => {
            if (!Cast.isCasting) video.play().catch(() => {});
        });
    };
    video.addEventListener('loadedmetadata', onMeta, { once: true });

    const urls = genererURLsFallback(v.video);
    chargerVideoAvecRetry(urls).then(success => {
        if (!success && !state.ready) $('mainTitle').textContent = '❌ Impossible de charger la vidéo';
    });

    localStorage.setItem('lastVideoUrl', v.video);
    updateActiveStates();
    updateMediaSession();
    displayNotes();
    sortirMiniPlayer(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (Cast.isCasting) Cast.load(v.video, resume, true);
}

function setupVideoEvents() {
    let saveTimer = 0;
    video.addEventListener('timeupdate', () => {
        if (!state.ready || state.currentIndex < 0) return;
        const v = state.allVideos[state.currentIndex];
        if (!v) return;
        const now = video.currentTime;
        if (state.lastTick !== null) {
            const delta = now - state.lastTick;
            if (delta > 0 && delta < 2 && !video.paused) state.watchedSeconds += delta;
        }
        state.lastTick = now;
        if (state.abLoop.active && state.abLoop.a !== null && state.abLoop.b !== null && now >= state.abLoop.b) {
            video.currentTime = state.abLoop.a;
        }
        if (++saveTimer % 20 === 0 && !video.ended) {
            setProgress(v.video, now, video.duration);
            const bar = document.querySelector(`.video-item[data-index="${state.currentIndex}"] .progress-bar`);
            if (bar && video.duration) bar.style.width = Math.min(100, (now / video.duration) * 100) + '%';
        }
    });
    video.addEventListener('waiting', () => {
        if (state.ready) afficherTampon(bufferedAhead(), bufferedAhead() + 10);
    });
    video.addEventListener('playing', () => masquerChargement());
    video.addEventListener('pause', () => {
        if (state.currentIndex >= 0 && state.ready) {
            const v = state.allVideos[state.currentIndex];
            if (v) setProgress(v.video, video.currentTime, video.duration);
        }
        flushStats();
        releaseWakeLock();
    });
    video.addEventListener('ended', () => {
        const v = state.allVideos[state.currentIndex];
        if (v) localStorage.removeItem('progress_' + v.video);
        flushStats();
        compterVideoVue();
        genererContinueWatching();
        renderGrid();
        if (state.currentIndex < state.allVideos.length - 1) {
            showToast('⏭️ Vidéo suivante…');
            setTimeout(() => jouerVideo(state.currentIndex + 1), 1200);
        }
    });
    video.addEventListener('play', requestWakeLock);
    video.addEventListener('error', () => {
        const err = video.error;
        if (!err || err.code === MediaError.MEDIA_ERR_ABORTED) return;
        console.log('[Rainbow] Erreur vidéo, retry géré par chargerVideoAvecRetry');
    });
}

function restaurerSession() {
    const url = localStorage.getItem('lastVideoUrl');
    if (!url) return;
    const i = state.allVideos.findIndex(v => v.video === url);
    if (i === -1) return;
    state.currentIndex = i;
    const v = state.allVideos[i];
    $('mainTitle').textContent = v.titre;
    video.poster = v.vignette || placeholderFor(v.titre);
    if (v.vignette) { $('ambilightBg').style.backgroundImage = `url("${v.vignette}")`; $('ambilightBg').classList.add('active'); }
    const p = getProgress(v.video);
    const onMeta = () => {
        if (p && p.t > 5 && p.t < video.duration - 3) {
            video.currentTime = p.t;
            $('resumeBadge').style.display = 'inline-block';
            $('resumeBadge').textContent = `▶ Reprendre (${formatTime(p.t)})`;
        }
        appliquerMixRadio();
        state.ready = true;
        masquerChargement();
    };
    video.addEventListener('loadedmetadata', onMeta, { once: true });
    const urls = genererURLsFallback(v.video);
    chargerVideoAvecRetry(urls);
    updateActiveStates();
    updateMediaSession();
    displayNotes();
}

function jouerVideoAleatoire() {
    if (!state.allVideos.length) return;
    let i;
    do { i = Math.floor(Math.random() * state.allVideos.length); }
    while (state.allVideos.length > 1 && i === state.currentIndex);
    jouerVideo(i);
}
function genererLienPartage() {
    if (state.currentIndex === -1) { showToast('⚠️ Lancez d\'abord une vidéo'); return; }
    const v = state.allVideos[state.currentIndex];
    const t = Math.floor(video.currentTime);
    const link = `${location.origin}${location.pathname}?v=${encodeURIComponent(v.video)}&t=${t}`;
    navigator.clipboard?.writeText(link).then(() => showToast('🔗 Lien copié !')).catch(() => prompt('Lien :', link));
}
function chargerVideoDepuisURL() {
    const p = new URLSearchParams(location.search);
    const vUrl = p.get('v');
    if (!vUrl) return;
    const t = parseInt(p.get('t')) || 0;
    const i = state.allVideos.findIndex(v => v.video === vUrl);
    if (i !== -1) jouerVideo(i, { startTime: t });
}
function toggleCinemaMode() {
    const p = $('mainPlayer');
    p.classList.toggle('cinema-mode');
    showToast(p.classList.contains('cinema-mode') ? '🎬 Mode cinéma' : 'Mode normal');
}

/* ---------- Picture-in-Picture natif (touche I) ---------- */
async function togglePiP() {
    if (!video.src && state.currentIndex === -1) { showToast("⚠️ Lancez d'abord une vidéo"); return; }
    try {
        if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
        if (typeof video.webkitSetPresentationMode === 'function') {
            video.webkitSetPresentationMode(video.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
            return;
        }
        if (document.pictureInPictureEnabled) await video.requestPictureInPicture();
        else showToast('⚠️ PiP non supporté par ce navigateur');
    } catch (e) { showToast('❌ PiP : ' + e.message); }
}
video.addEventListener('enterpictureinpicture', () => { const b = $('pipBtn'); if (b) b.classList.add('btn-primary'); });
video.addEventListener('leavepictureinpicture', () => { const b = $('pipBtn'); if (b) b.classList.remove('btn-primary'); });
video.addEventListener('webkitpresentationmodechanged', () => {
    const b = $('pipBtn');
    if (b) b.classList.toggle('btn-primary', video.webkitPresentationMode === 'picture-in-picture');
});
{
    const b = $('pipBtn');
    if (b && !document.pictureInPictureEnabled && typeof video.webkitSetPresentationMode !== 'function') b.style.display = 'none';
}
function sortirMiniPlayer(silent) {
    $('mainPlayer').classList.remove('mini-player');
    if (!silent) window.scrollTo({ top: 0, behavior: 'smooth' });
}
const playerObserver = new IntersectionObserver(entries => {
    const p = $('mainPlayer');
    if (document.fullscreenElement || document.pictureInPictureElement || Cast.isCasting) { p.classList.remove('mini-player'); return; }
    if (!entries[0].isIntersecting && !video.paused && video.src) p.classList.add('mini-player');
    else p.classList.remove('mini-player');
}, { threshold: 0.1 });

const Cast = {
    isCasting: false, ctx: null, sdkLoading: false,
    init() {
        if (!window.cast?.framework) return;
        this.ctx = cast.framework.CastContext.getInstance();
        this.ctx.setOptions({
            receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
            resumeSavedSession: true
        });
        this.ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, e => {
            const S = cast.framework.SessionState;
            if (e.sessionState === S.SESSION_STARTED || e.sessionState === S.SESSION_RESUMED) {
                this.isCasting = true;
                $('castBtn').classList.add('casting');
                $('castBtn').textContent = '📺 Connecté';
                const v = state.allVideos[state.currentIndex];
                if (v) this.load(v.video, video.currentTime, !video.paused);
            }
            if (e.sessionState === S.SESSION_ENDED) {
                this.isCasting = false;
                $('castBtn').classList.remove('casting');
                $('castBtn').textContent = '📺 Caster';
                showToast('📺 Cast terminé');
            }
        });
    },
    load(url, time, autoplay) {
        const session = this.ctx?.getCurrentSession();
        if (!session) return;
        const stableUrl = versLienStable(url) || url;
        const info = new chrome.cast.media.MediaInfo(stableUrl, 'video/mp4');
        info.metadata = new chrome.cast.media.GenericMediaMetadata();
        info.metadata.title = state.allVideos[state.currentIndex]?.titre || 'Rainbow Cinema';
        const artwork = state.allVideos[state.currentIndex]?.vignette;
        if (artwork && /^https?:/.test(artwork)) info.metadata.images = [new chrome.cast.Image(artwork)];
        const req = new chrome.cast.media.LoadRequest(info);
        req.currentTime = time || 0;
        req.autoplay = autoplay !== false;
        session.loadMedia(req).then(() => { video.pause(); showToast('📺 Diffusion sur le téléviseur'); })
            .catch(err => showToast('❌ Erreur cast : ' + (err.code || err)));
    },
    loadSdk() {
        if (this.sdkLoading || window.cast?.framework) return;
        this.sdkLoading = true;
        showToast('⏳ Chargement du module Chromecast…');
        const s = document.createElement('script');
        s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
        s.async = true;
        s.onerror = () => { this.sdkLoading = false; showToast('❌ Module Cast indisponible'); };
        document.head.appendChild(s);
    }
};
window.__onGCastApiAvailable = isAvailable => { if (isAvailable) { Cast.init(); showToast('📺 Chromecast prêt'); } };
async function casterVideo() {
    if (state.currentIndex === -1 && !video.src) { showToast('⚠️ Lancez d\'abord une vidéo'); return; }
    const url = state.allVideos[state.currentIndex]?.video || video.src;
    if (Cast.isCasting) { Cast.load(url, video.currentTime, true); return; }
    if (typeof video.webkitShowPlaybackTargetPicker === 'function') {
        try { video.webkitShowPlaybackTargetPicker(); return; } catch {}
    }
    if (video.remote && typeof video.remote.prompt === 'function') {
        try { await video.remote.prompt(); return; } catch {}
    }
    if (location.protocol === 'file:') {
        showToast('⚠️ Chromecast nécessite http(s) — ouvrez via un serveur local', 5000);
        return;
    }
    if (Cast.ctx) {
        try { await Cast.ctx.requestSession(); return; }
        catch { showToast('📺 Aucun appareil sélectionné'); return; }
    }
    if (!window.chrome && !navigator.userAgent.includes('Edg/')) {
        showToast('💡 Utilisez Chrome/Edge pour Chromecast, Safari pour AirPlay', 4500);
        window.open(url, '_blank', 'noopener');
        return;
    }
    Cast.loadSdk();
    setTimeout(() => {
        if (Cast.ctx) Cast.ctx.requestSession().catch(() => showToast('📺 Aucun Chromecast détecté'));
        else showToast('❌ Cast indisponible sur ce réseau');
    }, 2500);
}

function contextAction(action) {
    $('contextMenu').style.display = 'none';
    const v = state.contextTarget;
    if (!v) return;
    const idx = state.allVideos.indexOf(v);
    if (action === 'play') jouerVideo(idx);
    else if (action === 'fav') toggleFavorite(v.video, null);
    else if (action === 'copy') navigator.clipboard?.writeText(v.video).then(() => showToast('🔗 Lien copié !'));
    else if (action === 'cast') { jouerVideo(idx); setTimeout(casterVideo, 800); }
    else if (action === 'thumb') regenThumb(v);
}
async function regenThumb(v) {
    if (v.thumbKind === 'custom') { showToast('🎨 Vignette personnalisée depuis le JSON (non régénérable)'); return; }
    showToast('🖼️ Régénération en cours…');
    await Cache.set('thumbs', v.video, null);
    const data = await captureFrame(v.video, v.duration);
    if (!data) { showToast('❌ Capture impossible (CORS ou fichier)'); return; }
    await Cache.set('thumbs', v.video, data);
    v.vignette = data; v.thumbKind = 'auto';
    const img = document.querySelector(`.video-item[data-index="${state.allVideos.indexOf(v)}"] img`);
    if (img) img.src = data;
    showToast('✅ Vignette régénérée');
}
document.addEventListener('click', e => {
    if (!e.target.closest('.custom-context-menu')) $('contextMenu').style.display = 'none';
});

function toggleABLoop(point) {
    if (point === 'a') {
        state.abLoop.a = video.currentTime;
        state.abLoop.active = false;
        showToast(`🔵 Point A : ${formatTime(state.abLoop.a)}`);
    } else {
        if (state.abLoop.a === null) { showToast('⚠️ Définissez d\'abord le point A'); return; }
        if (video.currentTime <= state.abLoop.a) { showToast('⚠️ B doit être après A'); return; }
        state.abLoop.b = video.currentTime;
        state.abLoop.active = true;
        showToast(`🔴 Point B : ${formatTime(state.abLoop.b)} — boucle ON`);
    }
}
function notesKey() { return state.currentIndex >= 0 ? 'notes_' + state.allVideos[state.currentIndex].video : null; }
function addNote() {
    const key = notesKey();
    if (!key) { showToast('⚠️ Lancez une vidéo'); return; }
    const time = video.currentTime;
    const text = prompt(`Note à ${formatTime(time)} :`);
    if (!text) return;
    const notes = JSON.parse(localStorage.getItem(key) || '[]');
    notes.push({ time, text, date: new Date().toISOString() });
    notes.sort((a, b) => a.time - b.time);
    localStorage.setItem(key, JSON.stringify(notes));
    showToast('📝 Note ajoutée');
    displayNotes();
}
function deleteNote(i, ev) {
    ev.stopPropagation();
    const key = notesKey(); if (!key) return;
    const notes = JSON.parse(localStorage.getItem(key) || '[]');
    notes.splice(i, 1);
    localStorage.setItem(key, JSON.stringify(notes));
    displayNotes();
}
function displayNotes() {
    const key = notesKey();
    const list = $('notesList');
    if (!key) { list.innerHTML = '<p style="color:var(--text-muted);font-size:.9rem">Aucune vidéo en cours.</p>'; return; }
    const notes = JSON.parse(localStorage.getItem(key) || '[]');
    if (!notes.length) { list.innerHTML = '<p style="color:var(--text-muted);font-size:.9rem">Aucune note pour ce titre.</p>'; return; }
    list.innerHTML = notes.map((n, i) =>
        `<div class="note-item" onclick="seekTo(${n.time})">
            <button class="note-del" onclick="deleteNote(${i},event)">✕</button>
            <div class="note-time">${formatTime(n.time)}</div>
            <div class="note-text">${escapeHtml(n.text)}</div>
        </div>`).join('');
}
function seekTo(t) { video.currentTime = t; video.play().catch(() => {}); }
function toggleNotesPanel() { $('notesPanel').classList.toggle('open'); displayNotes(); }

function updateMediaSession() {
    if (!('mediaSession' in navigator) || state.currentIndex < 0) return;
    const v = state.allVideos[state.currentIndex];
    const art = /^https?:/.test(v.vignette || '') ? [{ src: v.vignette, sizes: '512x512', type: 'image/jpeg' }] : [];
    navigator.mediaSession.metadata = new MediaMetadata({ title: v.titre, artist: 'Rainbow Cinema', artwork: art });
}
if ('mediaSession' in navigator) {
    const h = {
        play: () => video.play(), pause: () => video.pause(),
        seekbackward: () => video.currentTime -= 10,
        seekforward: () => video.currentTime += 10,
        previoustrack: () => state.currentIndex > 0 && jouerVideo(state.currentIndex - 1),
        nexttrack: () => state.currentIndex < state.allVideos.length - 1 && jouerVideo(state.currentIndex + 1)
    };
    Object.entries(h).forEach(([k, fn]) => { try { navigator.mediaSession.setActionHandler(k, fn); } catch {} });
}
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator && !state.wakeLock) {
            state.wakeLock = await navigator.wakeLock.request('screen');
            state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
        }
    } catch {}
}
function releaseWakeLock() { try { state.wakeLock?.release(); } catch {} state.wakeLock = null; }
document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushStats();
    else if (!video.paused) requestWakeLock();
});
window.addEventListener('beforeunload', flushStats);

document.addEventListener('keydown', e => {
    const inInput = document.activeElement === $('searchInput') || document.activeElement === $('radioCustomUrl');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('searchInput').focus(); return; }
    if (inInput) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (e.key === 'Escape') { closeSettings(); $('notesPanel').classList.remove('open'); $('contextMenu').style.display = 'none'; return; }
    if (e.ctrlKey || e.metaKey) return;
    if (e.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const items = [...document.querySelectorAll('.video-item')];
        if (!items.length) return;
        const cols = Math.max(1, Math.round($('videoGrid').offsetWidth / items[0].offsetWidth));
        if (state.focusIndex === -1) state.focusIndex = 0;
        else {
            if (e.key === 'ArrowRight') state.focusIndex = Math.min(state.focusIndex + 1, items.length - 1);
            if (e.key === 'ArrowLeft') state.focusIndex = Math.max(state.focusIndex - 1, 0);
            if (e.key === 'ArrowDown') state.focusIndex = Math.min(state.focusIndex + cols, items.length - 1);
            if (e.key === 'ArrowUp') state.focusIndex = Math.max(state.focusIndex - cols, 0);
        }
        items.forEach(i => i.classList.remove('focused'));
        items[state.focusIndex].classList.add('focused');
        items[state.focusIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }
    switch (e.code) {
        case 'Space': e.preventDefault(); video.paused ? video.play() : video.pause(); break;
        case 'Enter': if (state.focusIndex >= 0) { const el = document.querySelectorAll('.video-item')[state.focusIndex]; if (el) jouerVideo(+el.dataset.index); } break;
        case 'KeyF': e.preventDefault(); document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen?.(); break;
        case 'KeyC': e.preventDefault(); toggleCinemaMode(); break;
        case 'KeyK': e.preventDefault(); casterVideo(); break;
        case 'KeyP': e.preventDefault(); toggleRadio(); break;
        case 'KeyI': e.preventDefault(); togglePiP(); break;
        case 'KeyM': e.preventDefault(); video.muted = !video.muted; showToast(video.muted ? '🔇 Muet' : '🔊 Son'); break;
        case 'KeyN': e.preventDefault(); toggleNotesPanel(); break;
        case 'KeyR': e.preventDefault(); jouerVideoAleatoire(); break;
        case 'ArrowRight': e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); break;
        case 'ArrowLeft': e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 10); break;
        case 'ArrowUp': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); showToast(`🔊 Vidéo ${Math.round(video.volume * 100)}%`, 900); break;
        case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); showToast(`🔉 Vidéo ${Math.round(video.volume * 100)}%`, 900); break;
        case 'KeyS':
            e.preventDefault();
            state.speedIndex = (state.speedIndex + 1) % state.speeds.length;
            video.playbackRate = state.speeds[state.speedIndex];
            showToast(`⏩ ${state.speeds[state.speedIndex]}x`);
            break;
        case 'KeyL':
            e.preventDefault();
            if (state.abLoop.a === null) toggleABLoop('a');
            else if (state.abLoop.b === null) toggleABLoop('b');
            else { state.abLoop = { a: null, b: null, active: false }; showToast('🔁 Boucle désactivée'); }
            break;
    }
});

$('searchInput').addEventListener('input', debounce(e => {
    state.query = e.target.value.trim().toLowerCase();
    renderGrid();
}, 200));

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
    e.preventDefault();
    for (const file of e.dataTransfer.files) {
        if (!file.type.startsWith('video/')) continue;
        state.currentIndex = -1;
        state.ready = true;
        masquerChargement();
        video.src = URL.createObjectURL(file);
        appliquerMixRadio();
        video.play().catch(() => {});
        $('mainTitle').textContent = file.name;
        showToast(`📂 Lecture locale : ${file.name}`);
        break;
    }
});

document.addEventListener('DOMContentLoaded', () => {
    if (navigator.storage?.persist) navigator.storage.persist().then(ok => console.log('💾 Stockage persistant accordé :', ok));
    setupVideoEvents();
    initRadio();
    afficherStats();
    chargerToutesLesVideos();
    setInterval(flushStats, 20000);
    setTimeout(() => playerObserver.observe($('mainPlayer')), 1200);
    if (location.protocol !== 'file:' && (window.chrome || navigator.userAgent.includes('Edg/'))) Cast.loadSdk();
    setInterval(genererContinueWatching, 60000);
});
