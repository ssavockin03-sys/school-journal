// ============================================================
// SUPABASE REST API + AUTH (мгновенная работа без Firebase)
// ============================================================
const SUPABASE_URL = 'https://' + 'school-journal-three' + '.vercel.app/sb';
const SUPABASE_KEY = 'sb_publishable_BKIpSEuY0iQJ5bm5qOU_Ww_5ceIs1UA';
const _SB_SESSION_KEY = 'sj_supabase_user_v1';

const SB_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
};

// Ограничитель параллельных соединений (не более 2 одновременно, чтобы провайдер не делал ERR_CONNECTION_RESET)
let _activeRequests = 0;
const _requestQueue = [];

function acquireSlot() {
    if (_activeRequests < 2) {
        _activeRequests++;
        return Promise.resolve();
    }
    return new Promise(resolve => _requestQueue.push(resolve));
}

function releaseSlot() {
    _activeRequests--;
    if (_requestQueue.length > 0) {
        _activeRequests++;
        const next = _requestQueue.shift();
        next();
    }
}

async function sbFetch(url, options = {}, timeoutMs = 5000, retries = 4) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        await acquireSlot();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                ...options,
                cache: 'no-store',
                signal: controller.signal
            });
            clearTimeout(timer);
            releaseSlot();
            return res;
        } catch (err) {
            clearTimeout(timer);
            releaseSlot();
            lastErr = err;
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
            }
        }
    }
    throw lastErr;
}



function getStoredUser() {
    try {
        const raw = localStorage.getItem(_SB_SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

function setStoredUser(userObj) {
    try {
        if (userObj) {
            localStorage.setItem(_SB_SESSION_KEY, JSON.stringify(userObj));
        } else {
            localStorage.removeItem(_SB_SESSION_KEY);
        }
    } catch (_) {}
}


// ============================================================
// DB (полная совместимость со всеми страницами проекта)
// ============================================================
const DB = {
    async getAll(table) {
        try {
            const res = await sbFetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?select=id,data,updated_at`, {
                method: 'GET',
                headers: SB_HEADERS
            });

            if (!res.ok) {
                console.error('DB.getAll(' + table + ') HTTP:', res.status);
                return [];
            }
            const rows = await res.json();
            const list = (rows || []).map(r => ({
                ...(r.data || {}),
                id: r.id
            }));

            if (table === 'journals') {
                const latestByKey = new Map();
                list.forEach(item => {
                    const key = item.class_id + '__' + item.subject_id;
                    const prev = latestByKey.get(key);
                    if (!prev || String(item.updated_at || '') >= String(prev.updated_at || '')) {
                        latestByKey.set(key, item);
                    }
                });
                return Array.from(latestByKey.values());
            }

            return list;
        } catch (e) {
            console.error('DB.getAll(' + table + '):', e);
            return [];
        }
    },

    async insert(table, row) {
        try {
            const id = String(row.id || ('row_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)));
            const payloadData = { ...row, id };
            const body = table === 'journals'
                ? {
                    id,
                    class_id: row.class_id || null,
                    subject_id: row.subject_id || null,
                    data: payloadData,
                    updated_at: row.updated_at || new Date().toISOString()
                }
                : { id, data: payloadData };

            const res = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}`, {
                method: 'POST',
                headers: { ...SB_HEADERS, 'Prefer': 'resolution=merge-duplicates,return=representation' },
                body: JSON.stringify(body)
            });
            if (!res.ok) return null;
            return payloadData;
        } catch (e) {
            console.error('DB.insert(' + table + '):', e);
            return null;
        }
    },

    async update(table, id, row) {
        try {
            const getRes = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?id=eq.${encodeURIComponent(id)}&select=data`, {
                method: 'GET',
                headers: SB_HEADERS
            });
            let existing = {};
            if (getRes.ok) {
                const arr = await getRes.json();
                if (arr && arr.length > 0 && arr[0].data) existing = arr[0].data;
            }
            const merged = { ...existing, ...row, id: String(id) };
            const patchBody = table === 'journals'
                ? {
                    class_id: merged.class_id || null,
                    subject_id: merged.subject_id || null,
                    data: merged,
                    updated_at: merged.updated_at || new Date().toISOString()
                }
                : { data: merged, updated_at: new Date().toISOString() };

            const res = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?id=eq.${encodeURIComponent(id)}`, {
                method: 'PATCH',
                headers: SB_HEADERS,
                body: JSON.stringify(patchBody)
            });
            if (!res.ok) return null;
            return merged;
        } catch (e) {
            console.error('DB.update(' + table + '):', e);
            return null;
        }
    },

    async remove(table, id) {
        try {
            const res = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?id=eq.${encodeURIComponent(id)}`, {
                method: 'DELETE',
                headers: SB_HEADERS
            });
            return res.ok;
        } catch (e) {
            console.error('DB.remove(' + table + '):', e);
            return false;
        }
    },
    async getJournal(classId, subjectId) {
        try {
            const url = `${SUPABASE_URL}/rest/v1/journals?class_id=eq.${encodeURIComponent(classId)}&subject_id=eq.${encodeURIComponent(subjectId)}&select=id,data,updated_at`;
            const res = await fetch(url, { method: 'GET', headers: SB_HEADERS });
            if (!res.ok) return null;
            const rows = await res.json();
            if (!rows || rows.length === 0) return null;
            const docs = rows.map(r => ({ ...(r.data || {}), id: r.id, updated_at: r.updated_at || (r.data && r.data.updated_at) }));
            docs.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
            return docs[0];

        } catch (e) {
            console.error('DB.getJournal:', e);
            return null;
        }
    },

    async upsertJournal(classId, subjectId, payload) {
        try {
            const compositeId = classId + '__' + subjectId;
            const nowIso = new Date().toISOString();
            const fullData = { id: compositeId, class_id: classId, subject_id: subjectId, ...payload, updated_at: nowIso };

            const res = await fetch(`${SUPABASE_URL}/rest/v1/journals`, {
                method: 'POST',
                headers: { ...SB_HEADERS, 'Prefer': 'resolution=merge-duplicates' },
                body: JSON.stringify({
                    id: compositeId,
                    class_id: classId,
                    subject_id: subjectId,
                    data: fullData,
                    updated_at: nowIso
                })
            });
            if (!res.ok) return null;

            const delUrl = `${SUPABASE_URL}/rest/v1/journals?class_id=eq.${encodeURIComponent(classId)}&subject_id=eq.${encodeURIComponent(subjectId)}&id=neq.${encodeURIComponent(compositeId)}`;
            fetch(delUrl, { method: 'DELETE', headers: SB_HEADERS }).catch(() => {});

            return fullData;
        } catch (e) {
            console.error('DB.upsertJournal:', e);
            return null;
        }
    }
};
window.DB = DB;

// ============================================================
// СОВМЕСТИМЫЙ AUTH-ИНТЕРФЕЙС (замена Firebase Auth)
// ============================================================
const _authListeners = new Set();

function notifyAuthListeners(user) {
    _authListeners.forEach(cb => {
        try { cb(user); } catch (_) {}
    });
}

const _sbCompat = {
    auth: {
        get currentUser() { return getStoredUser(); }
    },
    onAuthStateChanged(authObj, callback) {
        _authListeners.add(callback);
        setTimeout(() => callback(getStoredUser()), 0);
        return () => _authListeners.delete(callback);
    },
    async signInWithEmailAndPassword(authObj, email, password) {
        const cleanEmail = String(email || '').trim().toLowerCase();
        const login = cleanEmail.split('@')[0];

        const [students, teachers, admins, users, people] = await Promise.all([
            DB.getAll('students'),
            DB.getAll('teachers'),
            DB.getAll('admins'),
            DB.getAll('users'),
            DB.getAll('people')
        ]);

        const allAccounts = [...students, ...teachers, ...admins, ...users, ...people];

        const found = allAccounts.find(acc => {
            const accLogin = String(acc.login || '').trim().toLowerCase();
            const accEmail = String(acc.email || '').trim().toLowerCase();
            return accLogin === login || accEmail === cleanEmail;
        });

        if (!found) {
            const err = new Error('Пользователь не найден');
            err.code = 'auth/user-not-found';
            throw err;
        }

        if (found.password && String(found.password) !== String(password)) {
            const err = new Error('Неверный пароль');
            err.code = 'auth/wrong-password';
            throw err;
        }

        const userObj = {
            uid: String(found.id),
            email: cleanEmail.includes('@') ? cleanEmail : (login + '@school.local')
        };
        setStoredUser(userObj);
        notifyAuthListeners(userObj);
        return { user: userObj };
    },
    async createUserWithEmailAndPassword(authObj, email, password) {
        const cleanEmail = String(email || '').trim().toLowerCase();
        const login = cleanEmail.split('@')[0];
        const userObj = { uid: 'u_' + Date.now(), email: cleanEmail };
        await DB.insert('users', { id: userObj.uid, login, email: cleanEmail, password: String(password || '') });
        setStoredUser(userObj);
        notifyAuthListeners(userObj);
        return { user: userObj };
    },
    async signOut() {
        setStoredUser(null);
        notifyAuthListeners(null);
    }
};

window._fb = _sbCompat;
window._fbReady = Promise.resolve(_sbCompat);
window.dispatchEvent(new Event('firebase-ready'));
