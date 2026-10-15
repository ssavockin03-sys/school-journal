/* ============================================================
   ЧАТ ДЛЯ УЧЕНИКА
   Зависит от: DB (из supabase-config.js), CURRENT_STUDENT (из HTML ученика)
   ============================================================ */
(function () {
    'use strict';

    // ==== Состояние ====
    let contacts = [];           // [{ id, full_name, role, roleLabel, subject }]
    let contactsLoaded = false;
    let activeContact = null;    // { id, full_name, role }
    let lastSeenTs = null;       // для polling
    let pollTimer = null;
    let unreadByContact = {};    // { contactId: count }
    let panelOpen = false;

    // ==== Утилиты ====
    function getMyId() {
        return (window.CURRENT_STUDENT && window.CURRENT_STUDENT.id) || null;
    }
    function getMyName() {
        return (window.CURRENT_STUDENT && window.CURRENT_STUDENT.full_name) || 'Ученик';
    }
    function getMyClassId() {
        return (window.CURRENT_STUDENT && window.CURRENT_STUDENT.class_id) || null;
    }
    function chatIdFor(myId, otherId) {
        return [myId, otherId].sort().join('__');
    }
    function initials(name) {
        return (name || '').split(' ').map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
    }
    function escapeHtml(t) {
        if (t == null) return '';
        const d = document.createElement('div');
        d.textContent = String(t);
        return d.innerHTML;
    }
    function roleLabel(role) {
        return { teacher: 'Учитель', student: 'Ученик', parent: 'Родитель', admin: 'Администратор' }[role] || 'Участник';
    }
    function formatTime(iso) {
        try {
            const d = new Date(iso);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            return hh + ':' + mm;
        } catch (e) { return ''; }
    }

    // ==== Загрузка контактов ====
    async function loadContacts() {
        const myId = getMyId();
        const myClassId = getMyClassId();
        if (!myId || !myClassId) return [];

        const [students, teachers, workloads, people] = await Promise.all([
            DB.getAll('students'),
            DB.getAll('teachers'),
            DB.getAll('workloads'),
            DB.getAll('people').catch(() => [])
        ]);

        const list = [];
        const seen = new Set();

        // 1. Ученики моего класса (кроме меня)
        students
            .filter(s => s.class_id === myClassId && s.id !== myId)
            .forEach(s => {
                if (seen.has(s.id)) return;
                seen.add(s.id);
                list.push({ id: s.id, full_name: s.full_name, role: 'student', roleLabel: 'Ученик' });
            });

        // 2. Учителя, которые ведут в моём классе (через workload)
        const teacherIds = new Set();
        workloads
            .filter(w => w.class_id === myClassId && w.teacher_id)
            .forEach(w => teacherIds.add(w.teacher_id));
        teacherIds.forEach(tid => {
            const t = teachers.find(x => x.id === tid);
            if (!t || seen.has(t.id)) return;
            seen.add(t.id);
            list.push({ id: t.id, full_name: t.full_name, role: 'teacher', roleLabel: 'Учитель' + (t.subject ? ' · ' + t.subject : ''), subject: t.subject || '' });
        });

        // 3. Администратор (один)
        list.push({ id: '__admin__', full_name: 'Администратор', role: 'admin', roleLabel: 'Администрация' });

        // 4. Родители моего класса — по child_name === моё ФИО или ФИО любого ученика моего класса
        const myClassStudentNames = new Set(students.filter(s => s.class_id === myClassId).map(s => s.full_name));
        people
            .filter(p => p.role === 'parent' && p.child_name && myClassStudentNames.has(p.child_name))
            .forEach(p => {
                if (seen.has(p.id)) return;
                seen.add(p.id);
                const child = p.child_name || '';
                const childShort = child.split(' ').slice(0, 2).join(' ');
                list.push({ id: p.id, full_name: p.full_name, role: 'parent', roleLabel: 'Родитель · ' + childShort });
            });

        // Сортировка: учителя, потом ученики, потом родители, потом админ
        const order = { teacher: 0, student: 1, parent: 2, admin: 3 };
        list.sort((a, b) => (order[a.role] - order[b.role]) || a.full_name.localeCompare(b.full_name, 'ru'));

        contacts = list;
        contactsLoaded = true;
        return list;
    }

    // ==== Проверка непрочитанных ====
    async function refreshUnread() {
        const myId = getMyId();
        if (!myId) return;

        const all = await DB.getAll('chat_messages');
        const counts = {};

        all.forEach(m => {
            if (!m.chat_id || !m.from_id) return;
            if (m.from_id === myId) return;                     // свои не считаем
            // Проверяем, что чат — мой (личный) или общий
            const isMine = m.to_id === myId || m.chat_id.includes(myId);
            if (!isMine) return;
            // Не прочитано?
            const readBy = Array.isArray(m.read_by) ? m.read_by : [];
            if (readBy.includes(myId)) return;

            const key = m.from_id === '__admin__' ? '__admin__' : m.from_id;
            counts[key] = (counts[key] || 0) + 1;
        });

        unreadByContact = counts;

        // Общий счётчик
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const badge = document.getElementById('chatFabBadge');
        if (badge) {
            if (total > 0) {
                badge.textContent = total > 99 ? '99+' : String(total);
                badge.classList.add('show');
            } else {
                badge.classList.remove('show');
            }
        }

        // Если открыт список контактов — обновить цифры
        if (panelOpen && !activeContact) renderContactsList();
    }

    // ==== Пометка прочитанными ====
    async function markRead(contactId) {
        const myId = getMyId();
        if (!myId || !contactId) return;
        const cid = chatIdFor(myId, contactId);
        const all = await DB.getAll('chat_messages');
        for (const m of all) {
            if (m.chat_id !== cid) continue;
            if (m.from_id === myId) continue;
            const readBy = Array.isArray(m.read_by) ? m.read_by : [];
            if (readBy.includes(myId)) continue;
            readBy.push(myId);
            await DB.update('chat_messages', m.id, { read_by: readBy });
        }
    }

    // ==== Рендер списка контактов ====
    function renderContactsList() {
        const panel = document.getElementById('chatPanel');
        panel.innerHTML = `
            <div class="chat-header">
                <div class="chat-header-title">
                    <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                    Чаты
                </div>
                <button class="chat-header-close" type="button" id="chatCloseBtn">×</button>
            </div>
            <div class="chat-contacts" id="chatContactsBody"></div>
        `;
        document.getElementById('chatCloseBtn').addEventListener('click', closePanel);

        const body = document.getElementById('chatContactsBody');
        if (!contactsLoaded || contacts.length === 0) {
            body.innerHTML = '<div class="chat-empty-msg">Контакты не найдены</div>';
            return;
        }

        // Группировка
        const groups = { teacher: [], student: [], parent: [], admin: [] };
        contacts.forEach(c => groups[c.role].push(c));

        let html = '';
        const titles = { teacher: 'Учителя', student: 'Ученики', parent: 'Родители', admin: 'Администрация' };
        ['teacher', 'student', 'parent', 'admin'].forEach(role => {
            if (!groups[role].length) return;
            html += `<div class="chat-contacts-section">${titles[role]}</div>`;
            groups[role].forEach(c => {
                const unread = unreadByContact[c.id] || 0;
                html += `
                    <div class="chat-contact" data-id="${escapeHtml(c.id)}">
                        <div class="chat-avatar ${c.role}">${escapeHtml(initials(c.full_name))}</div>
                        <div class="chat-contact-info">
                            <div class="chat-contact-name">${escapeHtml(c.full_name)}</div>
                            <div class="chat-contact-role">${escapeHtml(c.roleLabel)}</div>
                        </div>
                        ${unread > 0 ? `<div class="chat-contact-badge">${unread > 99 ? '99+' : unread}</div>` : ''}
                    </div>
                `;
            });
        });
        body.innerHTML = html;

        body.querySelectorAll('.chat-contact').forEach(el => {
            el.addEventListener('click', () => openChat(el.dataset.id));
        });
    }

    // ==== Открыть переписку ====
    async function openChat(contactId) {
        const contact = contacts.find(c => c.id === contactId);
        if (!contact) return;
        activeContact = contact;
        await markRead(contactId);
        await renderMessages();
        await refreshUnread();

        // Автоскролл
        setTimeout(() => {
            const msgs = document.getElementById('chatMessages');
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
        }, 50);
    }

    // ==== Отрисовка переписки ====
    async function renderMessages() {
        const panel = document.getElementById('chatPanel');
        const myId = getMyId();
        const cid = chatIdFor(myId, activeContact.id);

        panel.innerHTML = `
            <div class="chat-header">
                <button class="chat-back-btn" type="button" id="chatBackBtn">
                    <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                </button>
                <div class="chat-header-title" style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(activeContact.full_name)}</div>
                <button class="chat-header-close" type="button" id="chatCloseBtn2">×</button>
            </div>
            <div class="chat-messages" id="chatMessages"><div class="chat-empty-msg">Загрузка...</div></div>
            <div class="chat-input-bar">
                <input type="text" id="chatInput" placeholder="Написать сообщение..." maxlength="1000">
                <button class="chat-send-btn" type="button" id="chatSendBtn" title="Отправить">
                    <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                </button>
            </div>
        `;
        document.getElementById('chatBackBtn').addEventListener('click', closeChat);
        document.getElementById('chatCloseBtn2').addEventListener('click', closePanel);
        const input = document.getElementById('chatInput');
        const sendBtn = document.getElementById('chatSendBtn');
        input.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
        sendBtn.addEventListener('click', sendMessage);

        // Загрузка сообщений
        const all = await DB.getAll('chat_messages');
        const msgs = all
            .filter(m => m.chat_id === cid)
            .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));

        const box = document.getElementById('chatMessages');
        if (msgs.length === 0) {
            box.innerHTML = '<div class="chat-empty-msg">Нет сообщений. Напишите первым!</div>';
            return;
        }
        box.innerHTML = msgs.map(m => {
            const mine = m.from_id === myId;
            return `<div class="chat-msg ${mine ? 'mine' : 'theirs'}">${escapeHtml(m.text)}<span class="chat-msg-time">${escapeHtml(formatTime(m.created_at))}</span></div>`;
        }).join('');
        box.scrollTop = box.scrollHeight;
        lastSeenTs = msgs.length ? msgs[msgs.length - 1].created_at : null;
    }

    // ==== Отправка сообщения ====
    async function sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;
        const myId = getMyId();
        const cid = chatIdFor(myId, activeContact.id);
        input.value = '';
        input.disabled = true;
        const btn = document.getElementById('chatSendBtn');
        if (btn) btn.disabled = true;

        const msg = {
            id: 'msg_' + Date.now() + '_' + Math.floor(Math.random() * 100000),
            chat_id: cid,
            from_id: myId,
            from_name: getMyName(),
            from_role: 'student',
            to_id: activeContact.id,
            text: text,
            created_at: new Date().toISOString(),
            read_by: [myId]
        };
        await DB.insert('chat_messages', msg);
        input.disabled = false;
        if (btn) btn.disabled = false;
        input.focus();
        await renderMessages();
    }

    // ==== Закрытие/открытие панели ====
    function openPanel() {
        panelOpen = true;
        activeContact = null;
        document.getElementById('chatPanel').classList.add('show');
        renderContactsList();
        refreshUnread();
    }
    function closePanel() {
        panelOpen = false;
        activeContact = null;
        document.getElementById('chatPanel').classList.remove('show');
    }
    function closeChat() {
        activeContact = null;
        renderContactsList();
        refreshUnread();
    }

    // ==== Polling новых сообщений ====
    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
            await refreshUnread();
            if (panelOpen && activeContact) {
                // Тихо обновляем открытую переписку
                const myId = getMyId();
                const cid = chatIdFor(myId, activeContact.id);
                const all = await DB.getAll('chat_messages');
                const msgs = all
                    .filter(m => m.chat_id === cid)
                    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
                const lastTs = msgs.length ? msgs[msgs.length - 1].created_at : null;
                if (lastTs && lastTs !== lastSeenTs) {
                    await markRead(activeContact.id);
                    await renderMessages();
                }
            }
        }, 5000);
    }

    // ==== Инициализация ====
    async function initChat() {
        const myId = getMyId();
        if (!myId) {
            // Подождём, пока CURRENT_STUDENT появится
            setTimeout(initChat, 500);
            return;
        }
        await loadContacts();
        await refreshUnread();

        // Кнопка в углу
        const fab = document.getElementById('chatFab');
        if (fab) fab.addEventListener('click', () => {
            if (panelOpen) closePanel(); else openPanel();
        });

        startPolling();
    }

    window.addEventListener('load', () => {
        // Небольшая задержка — чтобы HTML-скрипт ученика успел установить CURRENT_STUDENT
        setTimeout(initChat, 1000);
    });
})();
