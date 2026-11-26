// ============================================================
// FIREBASE (Firestore + Auth) — Моментальная загрузка без зависаний
// ============================================================
const firebaseConfig = {
    apiKey: "AIzaSyD1d1JQioGL8lHON8ydgtpHU1EXEwD00SY",
    authDomain: "://firebaseapp.com",
    projectId: "school-journal-8f39a",
    storageBucket: "school-journal-8f39a.firebasestorage.app",
    messagingSenderId: "254973926699",
    appId: "1:254973926699:web:43a7d8109df5366163396e"
};

let _fb = null;
let _firebaseReady = null;

function wrapAuth(auth, rawOnAuthStateChanged, rawSignOut) {
    const safeSignOut = async (authInstance) => {
        try { sessionStorage.clear(); } catch (_) {}
        return rawSignOut(authInstance);
    };

    const safeOnAuthStateChanged = (authInstance, callback) => {
        let called = false;
        const done = (user) => {
            if (called) return;
            called = true;
            clearTimeout(fallbackTimer);
            if (user && user.email) {
                try { sessionStorage.setItem('sj_cached_email', user.email); } catch (_) {}
            }
            callback(user);
        };

        if (authInstance && authInstance.currentUser) {
            setTimeout(() => done(authInstance.currentUser), 0);
            return () => {};
        }

        let unsub = () => {};
        try {
            unsub = rawOnAuthStateChanged(authInstance, (u) => done(u));
        } catch (e) {
            console.warn('onAuthStateChanged error:', e);
        }

        const fallbackTimer = setTimeout(() => {
            if (called) return;
            if (authInstance && authInstance.currentUser) {
                done(authInstance.currentUser);
                return;
            }
            let cachedEmail = null;
            try { cachedEmail = sessionStorage.getItem('sj_cached_email'); } catch (_) {}
            if (cachedEmail) {
                done({ email: cachedEmail, uid: 'cached' });
            } else {
                done(null);
            }
        }, 2500);

        return () => {
            clearTimeout(fallbackTimer);
            try { unsub(); } catch (_) {}
        };
    };

    return { safeOnAuthStateChanged, safeSignOut };
}

function loadFirebase() {
    if (window._fb) {
        _fb = window._fb;
        return Promise.resolve(_fb);
    }
    if (_firebaseReady) return _firebaseReady;

    _firebaseReady = new Promise((resolve, reject) => {
        const configJson = JSON.stringify(firebaseConfig);
        const host = ["www", "gstatic", "com"].join(".");
        const cdnBase = "https://" + [host, "firebasejs", "10.7.1"].join("/") + "/";

        let settled = false;
        let activeScript = null;
        let activeUrl = null;

        const finish = (rawFb) => {
            if (settled) return;
            settled = true;
            if (!rawFb._wrapped) {
                const wrapped = wrapAuth(rawFb.auth, rawFb.onAuthStateChanged, rawFb.signOut);
                rawFb.onAuthStateChanged = wrapped.safeOnAuthStateChanged;
                rawFb.signOut = wrapped.safeSignOut;
                rawFb._wrapped = true;
            }
            _fb = rawFb;
            window._fb = rawFb;
            clearInterval(pollInterval);
            clearTimeout(retryTimer);
            clearTimeout(hardTimeout);
            if (activeUrl) URL.revokeObjectURL(activeUrl);
            resolve(rawFb);
        };

        const injectScript = () => {
            if (settled) return;
            if (window._fb) return finish(window._fb);
            if (activeScript) activeScript.remove();
            if (activeUrl) URL.revokeObjectURL(activeUrl);

            const blob = new Blob([`
                import { initializeApp } from '${cdnBase}firebase-app.js';
                import { getFirestore, collection, getDocs, addDoc, updateDoc, deleteDoc, doc, query, where, setDoc } from '${cdnBase}firebase-firestore.js';
                import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence } from '${cdnBase}firebase-auth.js';

                const app = initializeApp(${configJson});
                const db = getFirestore(app);
                const auth = getAuth(app);
                setPersistence(auth, browserLocalPersistence).catch(() => {});

                window._fb = {
                    db, auth, collection, getDocs, addDoc, updateDoc, deleteDoc,
                    doc, query, where, setDoc,
                    signInWithEmailAndPassword, createUserWithEmailAndPassword,
                    signOut, onAuthStateChanged
                };
                window.dispatchEvent(new Event('firebase-ready'));
            `], { type: 'application/javascript' });

            activeUrl = URL.createObjectURL(blob);
            activeScript = document.createElement('script');
            activeScript.type = 'module';
            activeScript.src = activeUrl;
            activeScript.onerror = () => {
                if (!settled) setTimeout(injectScript, 400);
            };
            document.head.appendChild(activeScript);
        };

        window.addEventListener('firebase-ready', () => {
            if (window._fb) finish(window._fb);
        }, { once: true });

        const pollInterval = setInterval(() => {
            if (window._fb) finish(window._fb);
        }, 25);

        const retryTimer = setTimeout(() => {
            if (!settled) injectScript();
        }, 2000);

        const hardTimeout = setTimeout(() => {
            if (!settled) {
                clearInterval(pollInterval);
                _firebaseReady = null;
                reject(new Error('Не удалось загрузить Firebase SDK'));
            }
        }, 15000);

        injectScript();
    });

    return _firebaseReady;
}

window._fbReady = loadFirebase();
// ============================================================
// DB — Дедупликация запросов + быстрый кэш между страницами
// ============================================================
const _inFlight = new Map();
const _memCache = new Map();
const CACHE_TTL_MS = 25000;

function isHardReload() {
    try {
        const nav = performance.getEntriesByType('navigation');
        return nav && nav.type === 'reload';
    } catch (_) {
        return false;
    }
}

const _PAGE_IS_RELOAD = isHardReload();

const DB = {
    _invalidate(table) {
        _memCache.delete(table);
        _inFlight.delete(table);
        try { sessionStorage.removeItem('sj_tbl_' + table); } catch (_) {}
    },

    async getAll(table) {
        const now = Date.now();
        const useCache = !_PAGE_IS_RELOAD && table !== 'chat_messages';

        if (useCache) {
            const mem = _memCache.get(table);
            if (mem && (now - mem.ts < CACHE_TTL_MS)) return mem.data;

            try {
                const raw = sessionStorage.getItem('sj_tbl_' + table);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && (now - parsed.ts < CACHE_TTL_MS)) {
                        _memCache.set(table, parsed);
                        return parsed.data;
                    }
                }
            } catch (_) {}
        }

        if (_inFlight.has(table)) {
            return _inFlight.get(table);
        }

        const reqPromise = (async () => {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const fb = await loadFirebase();
                    const snap = await Promise.race([
                        fb.getDocs(fb.collection(fb.db, table)),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('Firestore timeout')), 4500))
                    ]);
                    let res = [];
                    snap.forEach(d => res.push({ id: d.id, ...d.data() }));

                    if (table === 'journals') {
                        const latestByKey = new Map();
                        res.forEach(item => {
                            const key = item.class_id + '__' + item.subject_id;
                            const prev = latestByKey.get(key);
                            if (!prev || String(item.updated_at || '') >= String(prev.updated_at || '')) {
                                latestByKey.set(key, item);
                            }
                        });
                        res = Array.from(latestByKey.values());
                    }

                    const entry = { ts: Date.now(), data: res };
                    _memCache.set(table, entry);
                    if (table !== 'chat_messages') {
                        try { sessionStorage.setItem('sj_tbl_' + table, JSON.stringify(entry)); } catch (_) {}
                    }
                    return res;
                } catch (e) {
                    console.warn('DB.getAll(' + table + ') attempt ' + (attempt + 1) + ':', e);
                    if (attempt === 1) {
                        try {
                            const fallback = JSON.parse(sessionStorage.getItem('sj_tbl_' + table) || 'null');
                            if (fallback && fallback.data) return fallback.data;
                        } catch (_) {}
                        return [];
                    }
                }
            }
            return [];
        })().finally(() => {
            _inFlight.delete(table);
        });

        _inFlight.set(table, reqPromise);
        return reqPromise;
    },

    async insert(table, row) {
        try {
            const fb = await loadFirebase();
            this._invalidate(table);
            if (row.id) {
                const { id, ...data } = row;
                await fb.setDoc(fb.doc(fb.db, table, id), data, { merge: true });
                return { id, ...data };
            } else {
                const ref = await fb.addDoc(fb.collection(fb.db, table), row);
                return { id: ref.id, ...row };
            }
        } catch (e) { console.error('DB.insert(' + table + '):', e); return null; }
    },

    async update(table, id, row) {
        try {
            const fb = await loadFirebase();
            this._invalidate(table);
            await fb.updateDoc(fb.doc(fb.db, table, id), row);
            return { id, ...row };
        } catch (e) { console.error('DB.update(' + table + '):', e); return null; }
    },

    async remove(table, id) {
        try {
            const fb = await loadFirebase();
            this._invalidate(table);
            await fb.deleteDoc(fb.doc(fb.db, table, id));
            return true;
        } catch (e) { console.error('DB.remove(' + table + '):', e); return false; }
    },

    async getJournal(classId, subjectId) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const fb = await loadFirebase();
                const snap = await Promise.race([
                    fb.getDocs(fb.query(fb.collection(fb.db, 'journals'), fb.where('class_id', '==', classId), fb.where('subject_id', '==', subjectId))),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('Firestore timeout')), 4500))
                ]);
                if (snap.empty) return null;
                const docs = [];
                snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
                docs.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
                return docs.at(0);
            } catch (e) {
                console.warn('DB.getJournal attempt ' + (attempt + 1) + ':', e);
                if (attempt === 1) return null;
            }
        }
        return null;
    },

    async upsertJournal(classId, subjectId, payload) {
        try {
            const fb = await loadFirebase();
            this._invalidate('journals');
            const compositeId = classId + '__' + subjectId;
            const data = { class_id: classId, subject_id: subjectId, ...payload, updated_at: new Date().toISOString() };
            await fb.setDoc(fb.doc(fb.db, 'journals', compositeId), data);

            const snap = await fb.getDocs(fb.query(fb.collection(fb.db, 'journals'), fb.where('class_id', '==', classId), fb.where('subject_id', '==', subjectId)));
            snap.forEach(d => {
                if (d.id !== compositeId) {
                    fb.deleteDoc(fb.doc(fb.db, 'journals', d.id)).catch(() => {});
                }
            });

            return { id: compositeId, ...data };
        } catch (e) { console.error('DB.upsertJournal:', e); return null; }
    }
};
window.DB = DB;
