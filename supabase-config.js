// ============================================================
// FIREBASE (Firestore + Auth)
// ============================================================
const firebaseConfig = {
    apiKey: "AIzaSyD1d1JQioGL8lHON8ydgtpHU1EXEwD00SY",
    authDomain: "school-journal-8f39a.firebaseapp.com",
    projectId: "school-journal-8f39a",
    storageBucket: "school-journal-8f39a.firebasestorage.app",
    messagingSenderId: "254973926699",
    appId: "1:254973926699:web:43a7d8109df5366163396e"
};

let _fb = null;
let _firebaseReady = null;

function loadFirebase() {
    if (_fb) return Promise.resolve(_fb);
    if (_firebaseReady) return _firebaseReady;

    _firebaseReady = new Promise((resolve, reject) => {
        const configJson = JSON.stringify(firebaseConfig);
        const blob = new Blob([`
            import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
            import { getFirestore, collection, getDocs, addDoc, updateDoc, deleteDoc, doc, query, where, setDoc } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
            import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

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

        window.addEventListener('firebase-ready', () => resolve(window._fb), { once: true });
        const interval = setInterval(() => { if (window._fb) { clearInterval(interval); resolve(window._fb); } }, 50);
        setTimeout(() => clearInterval(interval), 20000);

        const script = document.createElement('script');
        script.type = 'module';
        script.src = URL.createObjectURL(blob);
        script.onerror = () => reject(new Error('Не удалось загрузить Firebase SDK'));
        document.head.appendChild(script);
    });

    return _firebaseReady;
}

window._fbReady = loadFirebase();

// ============================================================
// DB
// ============================================================
const DB = {
    async getAll(table) {
        try {
            const fb = await loadFirebase();
            const snap = await fb.getDocs(fb.collection(fb.db, table));
            const res = [];
            snap.forEach(d => res.push({ id: d.id, ...d.data() }));
            return res;
        } catch (e) { console.error('DB.getAll(' + table + '):', e); return []; }
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
        try {
            const fb = await loadFirebase();
            const snap = await fb.getDocs(fb.query(fb.collection(fb.db, 'journals'), fb.where('class_id', '==', classId), fb.where('subject_id', '==', subjectId)));
            if (snap.empty) return null;
            const d = snap.docs[0];
            return { id: d.id, ...d.data() };
        } catch (e) { console.error('DB.getJournal:', e); return null; }
    },
    async upsertJournal(classId, subjectId, payload) {
        try {
            const fb = await loadFirebase();
            const snap = await fb.getDocs(fb.query(fb.collection(fb.db, 'journals'), fb.where('class_id', '==', classId), fb.where('subject_id', '==', subjectId)));
            const data = { class_id: classId, subject_id: subjectId, ...payload, updated_at: new Date().toISOString() };
            if (!snap.empty) {
                const docId = snap.docs[0].id;
                await fb.updateDoc(fb.doc(fb.db, 'journals', docId), data);
                return { id: docId, ...data };
            } else {
                const compositeId = classId + '__' + subjectId;
                await fb.setDoc(fb.doc(fb.db, 'journals', compositeId), data);
                return { id: compositeId, ...data };
            }
        } catch (e) { console.error('DB.upsertJournal:', e); return null; }
    }
};
window.DB = DB;
