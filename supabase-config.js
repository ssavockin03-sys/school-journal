const SUPABASE_URL = 'https://kbjmorswqahbvpecsrjz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_AszCHIeBm-RfVa0BsTPLbA_JQS7UmlY';

let _sbClient = null;
let _supabaseReady = null;

function loadSupabase() {
    if (_sbClient) return Promise.resolve(_sbClient);
    if (_supabaseReady) return _supabaseReady;

    _supabaseReady = new Promise((resolve, reject) => {
        const urlJson = JSON.stringify(SUPABASE_URL);
        const keyJson = JSON.stringify(SUPABASE_ANON_KEY);

        const blob = new Blob([`
            import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
            const client = createClient(${urlJson}, ${keyJson});
            window._sb = client;
            window.dispatchEvent(new Event('supabase-ready'));
        `], { type: 'application/javascript' });

        window.addEventListener('supabase-ready', () => resolve(window._sb), { once: true });

        const interval = setInterval(() => {
            if (window._sb) { clearInterval(interval); resolve(window._sb); }
        }, 50);
        setTimeout(() => clearInterval(interval), 20000);

        const script = document.createElement('script');
        script.type = 'module';
        script.src = URL.createObjectURL(blob);
        script.onerror = () => reject(new Error('Не удалось загрузить Supabase SDK'));
        document.head.appendChild(script);
    });

    return _supabaseReady;
}

window._sbReady = loadSupabase();

const DB = {
    async getAll(table) {
        try {
            const sb = await loadSupabase();
            const { data, error } = await sb.from(table).select('*');
            if (error) throw error;
            return data || [];
        } catch (e) { console.error('DB.getAll(' + table + '):', e); return []; }
    },
    async insert(table, row) {
        try {
            const sb = await loadSupabase();
            const payload = { ...row };
            if (!payload.id) payload.id = table + '_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
            const { data, error } = await sb.from(table).upsert(payload, { onConflict: 'id' }).select().maybeSingle();
            if (error) throw error;
            return data || payload;
        } catch (e) { console.error('DB.insert(' + table + '):', e); return null; }
    },
    async update(table, id, patch) {
        try {
            const sb = await loadSupabase();
            const { data, error } = await sb.from(table).update(patch).eq('id', id).select().maybeSingle();
            if (error) throw error;
            return data || { id, ...patch };
        } catch (e) { console.error('DB.update(' + table + '):', e); return null; }
    },
    async remove(table, id) {
        try {
            const sb = await loadSupabase();
            const { error } = await sb.from(table).delete().eq('id', id);
            if (error) throw error;
            return true;
        } catch (e) { console.error('DB.remove(' + table + '):', e); return false; }
    },
    async getJournal(classId, subjectId) {
        try {
            const sb = await loadSupabase();
            const compositeId = classId + '__' + subjectId;
            const { data, error } = await sb.from('journals').select('*').eq('id', compositeId).maybeSingle();
            if (error) throw error;
            return data || null;
        } catch (e) { console.error('DB.getJournal:', e); return null; }
    },
    async upsertJournal(classId, subjectId, payload) {
        try {
            const sb = await loadSupabase();
            const compositeId = classId + '__' + subjectId;
            const data = {
                id: compositeId, class_id: classId, subject_id: subjectId,
                grades: payload.grades || {}, lessons: payload.lessons || {},
                qtr_grades: payload.qtr_grades || {}, lesson_types: payload.lesson_types || {},
                updated_at: new Date().toISOString()
            };
            const { data: saved, error } = await sb.from('journals').upsert(data, { onConflict: 'id' }).select().maybeSingle();
            if (error) throw error;
            return saved || data;
        } catch (e) { console.error('DB.upsertJournal:', e); return null; }
    }
};

window.DB = DB;
