// ============================================================
// FIREBASE (Firestore + Auth) — Стабильная инициализация
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

async function loadFirebase(retries = 2) {
    if (_fb) return _fb;
    if (_firebaseReady) return _firebaseReady;

    _firebaseReady = (async () => {
        const cdnBase = "https://gstatic.com";
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const [appMod, fsMod, authMod] = await Promise.all([
                    import(`${cdnBase}firebase-app.js`),
                    import(`${cdnBase}firebase-firestore.js`),
                    import(`${cdnBase}firebase-auth.js`)
                ]);

                const app = appMod.initializeApp(firebaseConfig);
                const db = fsMod.getFirestore(app);
                const auth = authMod.getAuth(app);
                await authMod.setPersistence(auth, authMod.browserLocalPersistence).catch(() => {});

                _fb = {
                    db, auth,
                    collection: fsMod.collection,
                    getDocs: fsMod.getDocs,
                    addDoc: fsMod.addDoc,
                    updateDoc: fsMod.updateDoc,
                    deleteDoc: fsMod.deleteDoc,
                    doc: fsMod.doc,
                    query: fsMod.query,
                    where: fsMod.where,
                    setDoc: fsMod.setDoc,
                    signInWithEmailAndPassword: authMod.signInWithEmailAndPassword,
                    createUserWithEmailAndPassword: authMod.createUserWithEmailAndPassword,
                    signOut: authMod.signOut,
                    onAuthStateChanged: authMod.onAuthStateChanged
                };

                window._fb = _fb;
                window.dispatchEvent(new Event('firebase-ready'));
                return _fb;
            } catch (err) {
                console.warn(`Попытка загрузки Firebase #${attempt + 1} не удалась:`, err);
                if (attempt === retries) {
                    _firebaseReady = null;
                    throw err;
                }
                await new Promise(r => setTimeout(r, 800));
            }
        }
    })();

    return _firebaseReady;
}

window._fbReady = loadFirebase();
// ============================================================
// DB (с защитой от зависаний и быстрым кэшем)
// ============================================================
const _memCache = new Map();

function withTimeout(promise, ms = 6000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase timeout')), ms))
    ]);
}

const DB = {
    _clearCache(table) {
        _memCache.delete(table);
        try { sessionStorage.removeItem('db_cache_' + table); } catch (_) {}
    },

    async getAll(table, forceRefresh = false) {
        if (!forceRefresh) {
            if (_memCache.has(table)) return _memCache.get(table);
            try {
                const cached = sessionStorage.getItem('db_cache_' + table);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    _memCache.set(table, parsed);
                    // Фоновое обновление, чтобы данные оставались актуальными
                    this.getAll(table, true).catch(() => {});
                    return parsed;
                }
            } catch (_) {}
        }

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const fb = await withTimeout(loadFirebase(), 6000);
                const snap = await withTimeout(fb.getDocs(fb.collection(fb.db, table)), 6000);
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

                _memCache.set(table, res);
                try { sessionStorage.setItem('db_cache_' + table, JSON.stringify(res)); } catch (_) {}
                return res;
            } catch (e) {
                console.warn(`DB.getAll(${table}) попытка ${attempt + 1}:`, e);
                if (attempt === 1) return [];
                await new Promise(r => setTimeout(r, 500));
            }
        }
        return [];
    },

    async insert(table, row) {
        try {
            const fb = await loadFirebase();
            this._clearCache(table);
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
            this._clearCache(table);
            await fb.updateDoc(fb.doc(fb.db, table, id), row);
            return { id, ...row };
        } catch (e) { console.error('DB.update(' + table + '):', e); return null; }
    },

    async remove(table, id) {
        try {
            const fb = await loadFirebase();
            this._clearCache(table);
            await fb.deleteDoc(fb.doc(fb.db, table, id));
            return true;
        } catch (e) { console.error('DB.remove(' + table + '):', e); return false; }
    },

    async getJournal(classId, subjectId) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const fb = await withTimeout(loadFirebase(), 6000);
                const snap = await withTimeout(
                    fb.getDocs(fb.query(fb.collection(fb.db, 'journals'), fb.where('class_id', '==', classId), fb.where('subject_id', '==', subjectId))),
                    6000
                );
                if (snap.empty) return null;
                const docs = [];
                snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
                docs.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
                return docs.at(0);
            } catch (e) {
                console.warn(`DB.getJournal попытка ${attempt + 1}:`, e);
                if (attempt === 1) return null;
            }
        }
        return null;
    },

    async upsertJournal(classId, subjectId, payload) {
        try {
            const fb = await loadFirebase();
            this._clearCache('journals');
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
