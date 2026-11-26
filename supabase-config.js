// ============================================================
// FIREBASE (Firestore + Auth) — Оригинальный Blob + защита от зависания
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

        const finish = (fbInstance) => {
            if (settled) return;
            settled = true;
            _fb = fbInstance;
            clearInterval(pollInterval);
            clearTimeout(retryTimer);
            clearTimeout(hardTimeout);
            if (activeUrl) URL.revokeObjectURL(activeUrl);
            resolve(fbInstance);
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
                if (!settled) setTimeout(injectScript, 500);
            };
            document.head.appendChild(activeScript);
        };

        window.addEventListener('firebase-ready', () => {
            if (window._fb) finish(window._fb);
        }, { once: true });

        const pollInterval = setInterval(() => {
            if (window._fb) finish(window._fb);
        }, 30);

        // Если за 2.5 секунды не загрузилось — автоматически перезапускаем скрипт без F5
        const retryTimer = setTimeout(() => {
            if (!settled) injectScript();
        }, 2500);

        const hardTimeout = setTimeout(() => {
            if (!settled) {
                clearInterval(pollInterval);
                _firebaseReady = null;
                reject(new Error('Не удалось загрузить Firebase SDK'));
            }
        }, 20000);

        injectScript();
    });

    return _firebaseReady;
}

window._fbReady = loadFirebase();

// ============================================================
// DB
// ============================================================
const DB = {
    async getAll(table) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const fb = await loadFirebase();
                const snap = await Promise.race([
                    fb.getDocs(fb.collection(fb.db, table)),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
                ]);
                const res = [];
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
                    return Array.from(latestByKey.values());
                }
                return res;
            } catch (e) {
                console.error('DB.getAll(' + table + '):', e);
                if (attempt === 1) return [];
            }
        }
        return [];
    },

    async insert(table, row) {
        try {
            const fb = await loadFirebase();
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
            await fb.updateDoc(fb.doc(fb.db, table, id), row);
            return { id, ...row };
        } catch (e) { console.error('DB.update(' + table + '):', e); return null; }
    },
    async remove(table, id) {
        try {
            const fb = await loadFirebase();
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
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
                ]);
                if (snap.empty) return null;
                const docs = [];
                snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
                docs.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
                return docs.at(0);
            } catch (e) {
                console.error('DB.getJournal:', e);
                if (attempt === 1) return null;
            }
        }
        return null;
    },
    async upsertJournal(classId, subjectId, payload) {
        try {
            const fb = await loadFirebase();
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
