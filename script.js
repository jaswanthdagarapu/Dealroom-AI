/**
 * Perplexity AI — Application Logic
 *
 * Features:
 *  - Multi-turn chat with Gemini 2.5 Flash (SSE streaming)
 *  - Persistent chat history in LocalStorage
 *  - Web Speech API voice input with pulse animation
 *  - Toast notifications with auto-retry on 503
 *  - Sidebar toggle, new chat, delete, clear all
 */

document.addEventListener('DOMContentLoaded', () => App.init());

const App = (() => {

    // =====================================================================
    // STATE
    // =====================================================================
    const STORAGE_KEY = 'perplexity_chat_history';

    let sessions = [];          // [{ id, title, messages: [{role,content}], ts }]
    let activeSessionId = null;
    let isStreaming = false;
    let abortCtrl = null;
    let uploadedFileId = null;
    let currentFile = null;       // Currently attached file for general chat
    let currentDealRoomId = null; // Track if we are in a deal room context

    const DEALROOM_API = 'http://localhost:5001';
    let userToken = localStorage.getItem('dr_token') || null;
    let isAuthRegister = false;

    // Voice recognition
    let recognition = null;
    let isRecording = false;

    // =====================================================================
    // DOM CACHE
    // =====================================================================
    const $ = (s) => document.querySelector(s);
    const el = {};

    function cacheDom() {
        el.sidebar       = $('#sidebar');
        el.sidebarOverlay = $('#sidebar-overlay');
        el.sidebarToggle = $('#sidebar-toggle');
        el.topbarMenu    = $('#topbar-menu');
        el.topbarTitle   = $('#topbar-title');
        el.historyList   = $('#history-list');
        el.btnNewChat    = $('#btn-new-chat');
        el.btnClearAll   = $('#btn-clear-all');

        el.homeView      = $('#home-view');
        el.chatView      = $('#chat-view');
        el.chatMessages  = $('#chat-messages');

        el.searchForm    = $('#search-form');
        el.searchInput   = $('#search-input');
        el.chatForm      = $('#chat-form');
        el.chatInput     = $('#chat-input');

        el.homeVoiceBtn  = $('#home-voice-btn');
        el.chatVoiceBtn  = $('#chat-voice-btn');

        el.toastContainer = $('#toast-container');

        el.confirmModal  = $('#confirm-modal');
        el.modalCancel   = $('#modal-cancel');
        el.modalConfirm  = $('#modal-confirm');

        el.globalFileUpload = $('#global-file-upload');
        el.homeAttachBtn = $('#home-attach-btn');
        el.chatAttachBtn = $('#chat-attach-btn');
        el.fileBadgeHome = $('#file-badge-home');
        el.fileBadgeChat = $('#file-badge-chat');
        el.removeFileHome = el.fileBadgeHome.querySelector('.file-badge__remove');
        el.removeFileChat = el.fileBadgeChat.querySelector('.file-badge__remove');
        el.fileNameHome = el.fileBadgeHome.querySelector('.file-badge__name');
        el.fileNameChat = el.fileBadgeChat.querySelector('.file-badge__name');

        // DealRoom Elements
        el.drTitle       = $('#dr-title');
        el.navChat       = $('#nav-chat');
        el.navDealRooms  = $('#nav-dealrooms');
        el.dealroomView  = $('#dealroom-view');
        el.roomGrid      = $('#room-grid');
        el.createRoomBtn = $('#btn-create-room');
        el.roomModal     = $('#room-modal');
        el.roomForm      = $('#room-form');
        el.closeRoomModal = $('#btn-close-room-modal');
        el.drDashboard   = $('#dr-dashboard');
        el.drRoomDetail  = $('#dr-room-detail');
        el.backToRooms   = $('#btn-back-to-rooms');
        el.activeRoomName = $('#active-room-name');
        el.activeRoomDesc = $('#active-room-desc');
        el.launchRagBtn  = $('#btn-launch-rag');
        el.uploadDrBtn   = $('#btn-upload-dr');
        el.generateReportBtn = $('#btn-generate-report');
        el.roomReportsList = $('#room-reports-list');

        // Report Viewer
        el.reportModal    = $('#report-modal');
        el.reportMdContent = $('#report-md-content');
        el.copyReportBtn  = $('#btn-copy-report');
        el.downloadReportBtn = $('#btn-download-report');
        el.closeReportBtn = $('#btn-close-report');
        el.genOverlay     = $('#gen-overlay');

        // Trends Modal
        el.trendsModal   = $('#trends-modal');
        el.viewTrendsBtn = $('#btn-view-trends');
        el.closeTrendsBtn = $('#btn-close-trends');
        
        // Chart Contexts
        el.chartRevenue = $('#chart-revenue');
        el.chartEbitda  = $('#chart-ebitda');

        // Internal State for Charts
        el.charts = {};

        // Auth Elements
        el.authModal     = $('#auth-modal');
        el.authForm      = $('#auth-form');
        el.authTitle     = $('#auth-title');
        el.authDesc      = $('#auth-desc');
        el.groupName     = $('#group-name');
        el.authSubmitText = $('#auth-submit-text');
        el.btnToggleAuth = $('#btn-toggle-auth');
        el.authSwitchText = $('#auth-switch-text');
    }

    // =====================================================================
    // INITIALIZATION
    // =====================================================================
    function init() {
        cacheDom();
        loadSessions();
        renderHistoryList();
        bindEvents();
        setupVoice();
        autoGrowTextarea(el.searchInput);
        autoGrowTextarea(el.chatInput);
    }

    // =====================================================================
    // EVENTS
    // =====================================================================
    function bindEvents() {
        // Sidebar toggle
        el.sidebarToggle.addEventListener('click', toggleSidebar);
        el.topbarMenu.addEventListener('click', toggleSidebar);
        el.sidebarOverlay.addEventListener('click', closeSidebar);

        // New chat
        el.btnNewChat.addEventListener('click', newChat);

        // Clear all
        el.btnClearAll.addEventListener('click', () => showConfirmModal());
        el.modalCancel.addEventListener('click', hideModal);
        el.modalConfirm.addEventListener('click', () => { clearAllHistory(); hideModal(); });

        // Search form
        el.searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const t = el.searchInput.value.trim();
            if (!t || isStreaming) return;
            startConversation(t);
        });

        // Chat form
        el.chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const t = el.chatInput.value.trim();
            if (!t || isStreaming) return;
            sendFollowUp(t);
        });

        // Enter to submit
        [el.searchInput, el.chatInput].forEach(ta => {
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    ta.closest('form').dispatchEvent(new Event('submit'));
                }
            });
        });

        // Suggestion chips (only those in home view, not functional ones)
        document.querySelectorAll('.suggestion-chip').forEach(chip => {
            // Skip the DealRoom-specific buttons that use the same styling class
            if (chip.id === 'btn-upload-dr' || chip.id === 'btn-generate-report' || chip.id === 'btn-view-trends') return;
            
            chip.addEventListener('click', () => {
                const text = chip.textContent.trim();
                el.searchInput.value = text;
                startConversation(text);
            });
        });

        // Voice buttons
        el.homeVoiceBtn.addEventListener('click', () => toggleVoice(el.searchInput, el.homeVoiceBtn));
        el.chatVoiceBtn.addEventListener('click', () => toggleVoice(el.chatInput, el.chatVoiceBtn));

        // File Attach
        el.homeAttachBtn.addEventListener('click', () => el.globalFileUpload.click());
        el.chatAttachBtn.addEventListener('click', () => el.globalFileUpload.click());
        el.uploadDrBtn.addEventListener('click', () => el.globalFileUpload.click());
        el.globalFileUpload.addEventListener('change', handleFileUpload);
        el.removeFileHome.addEventListener('click', removeFile);
        el.removeFileChat.addEventListener('click', removeFile);

        // DealRoom Nav
        el.navChat.addEventListener('click', () => switchMainView('chat'));
        el.navDealRooms.addEventListener('click', () => switchMainView('dealroom'));

        // Auth
        el.btnToggleAuth.addEventListener('click', toggleAuthMode);
        el.authForm.addEventListener('submit', handleAuthSubmit);

        // Room Management
        el.createRoomBtn.addEventListener('click', () => el.roomModal.style.display = 'flex');
        el.closeRoomModal.addEventListener('click', () => el.roomModal.style.display = 'none');
        el.roomForm.addEventListener('submit', handleCreateRoom);
        el.backToRooms.addEventListener('click', showDrDashboard);
        el.launchRagBtn.addEventListener('click', launchRoomAnalysis);
        el.generateReportBtn.addEventListener('click', handleGenerateReport);
        el.closeReportBtn.addEventListener('click', () => el.reportModal.style.display = 'none');
        el.copyReportBtn.addEventListener('click', copyReportToClipboard);
        el.downloadReportBtn.addEventListener('click', downloadReportAsMarkdown);
        el.viewTrendsBtn.addEventListener('click', handleViewTrends);
        el.closeTrendsBtn.addEventListener('click', () => el.trendsModal.style.display = 'none');
    }

    // =====================================================================
    // SIDEBAR TOGGLE
    // =====================================================================
    function toggleSidebar() {
        el.sidebar.classList.toggle('collapsed');
        if (!el.sidebar.classList.contains('collapsed')) {
            el.sidebarOverlay.classList.add('visible');
        } else {
            el.sidebarOverlay.classList.remove('visible');
        }
    }

    function closeSidebar() {
        el.sidebar.classList.add('collapsed');
        el.sidebarOverlay.classList.remove('visible');
    }

    // =====================================================================
    // VIEWS
    // =====================================================================
    function showHome() {
        el.homeView.style.display = 'flex';
        el.chatView.style.display = 'none';
        el.topbarTitle.textContent = 'New Chat';
        el.searchInput.value = '';
        el.searchInput.focus();
    }

    function showChat() {
        el.homeView.style.display = 'none';
        el.dealroomView.style.display = 'none';
        el.chatView.style.display = 'flex';
        el.chatInput.focus();
    }

    function switchMainView(view) {
        // Update Nav UI
        el.navChat.classList.remove('active');
        el.navDealRooms.classList.remove('active');

        if (view === 'chat') {
            el.navChat.classList.add('active');
            if (activeSessionId) showChat(); else showHome();
        } else if (view === 'dealroom') {
            if (!userToken) {
                el.authModal.style.display = 'flex';
                return;
            }
            el.navDealRooms.classList.add('active');
            el.homeView.style.display = 'none';
            el.chatView.style.display = 'none';
            el.dealroomView.style.display = 'flex';
            loadDealRooms();
        }
        closeSidebar();
    }

    function showDrDashboard() {
        el.drDashboard.style.display = 'block';
        el.drRoomDetail.style.display = 'none';
        if (el.drTitle) el.drTitle.textContent = 'DealRoom Dashboard';
        currentDealRoomId = null;
    }

    // =====================================================================
    // HISTORY — LocalStorage CRUD
    // =====================================================================
    function loadSessions() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            sessions = raw ? JSON.parse(raw) : [];
        } catch (_) { sessions = []; }
    }

    function saveSessions() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    }

    function createSession(firstMessage) {
        const session = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            title: firstMessage.slice(0, 60),
            messages: [],
            ts: Date.now(),
        };
        sessions.unshift(session);
        activeSessionId = session.id;
        saveSessions();
        renderHistoryList();
        return session;
    }

    function getActiveSession() {
        return sessions.find(s => s.id === activeSessionId) || null;
    }

    function pushMessage(role, content) {
        const session = getActiveSession();
        if (!session) return;
        session.messages.push({ role, content });
        session.ts = Date.now();
        saveSessions();
    }

    function deleteSession(id) {
        sessions = sessions.filter(s => s.id !== id);
        saveSessions();
        if (activeSessionId === id) {
            activeSessionId = null;
            showHome();
        }
        renderHistoryList();
    }

    function clearAllHistory() {
        sessions = [];
        activeSessionId = null;
        saveSessions();
        renderHistoryList();
        showHome();
        showToast('success', 'History Cleared', 'All conversations have been deleted.');
    }

    function loadSession(id) {
        const session = sessions.find(s => s.id === id);
        if (!session) return;
        activeSessionId = id;
        el.chatMessages.innerHTML = '';
        el.topbarTitle.textContent = session.title;
        showChat();

        // Re-render all messages
        for (const msg of session.messages) {
            renderMessage(msg.role, msg.content, msg.role === 'model');
        }

        renderHistoryList();
        scrollToBottom();
    }

    // =====================================================================
    // HISTORY — Sidebar Rendering
    // =====================================================================
    function renderHistoryList() {
        if (!sessions.length) {
            el.historyList.innerHTML = `<div class="sidebar__history-empty"><i class="ph ph-chat-circle-dots" style="font-size:1.5rem;display:block;margin-bottom:0.5rem"></i>No conversations yet</div>`;
            return;
        }

        el.historyList.innerHTML = sessions.map(s => `
            <div class="history-item ${s.id === activeSessionId ? 'active' : ''}" data-id="${s.id}">
                <i class="ph ph-chat-circle history-item__icon"></i>
                <span class="history-item__text">${escapeHtml(s.title)}</span>
                <button class="history-item__delete" data-delete="${s.id}" aria-label="Delete chat" title="Delete">
                    <i class="ph ph-trash"></i>
                </button>
            </div>
        `).join('');

        // Bind clicks
        el.historyList.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.history-item__delete')) return;
                loadSession(item.dataset.id);
                closeSidebar();
            });
        });

        el.historyList.querySelectorAll('.history-item__delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteSession(btn.dataset.delete);
            });
        });
    }

    // =====================================================================
    // CONVERSATION
    // =====================================================================
    function newChat() {
        if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
        isStreaming = false;
        activeSessionId = null;
        el.chatMessages.innerHTML = '';
        el.chatInput.value = '';
        showHome();
        renderHistoryList();
        closeSidebar();
    }

    function startConversation(text) {
        createSession(text);
        el.chatMessages.innerHTML = '';
        showChat();
        addUserMessage(text);
        streamAIResponse();
    }

    function sendFollowUp(text) {
        addUserMessage(text);
        el.chatInput.value = '';
        resetHeight(el.chatInput);
        streamAIResponse();
    }

    function addUserMessage(text) {
        pushMessage('user', text);
        renderMessage('user', text);
    }

    // =====================================================================
    // MESSAGE RENDERING
    // =====================================================================

    /**
     * Protects LaTeX delimiters from markdown processing, runs marked,
     * then applies KaTeX auto-render to the resulting DOM element.
     */
    function renderMarkdownWithMath(element, rawText) {
        const mathBlocks = [];
        let protected_ = rawText;

        // Protect display math $$...$$ first
        protected_ = protected_.replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex) => {
            const id = `%%MATH_BLOCK_${mathBlocks.length}%%`;
            mathBlocks.push({ id, tex, display: true });
            return id;
        });

        // Protect inline math $...$
        protected_ = protected_.replace(/\$([^$\n]+?)\$/g, (_match, tex) => {
            const id = `%%MATH_BLOCK_${mathBlocks.length}%%`;
            mathBlocks.push({ id, tex, display: false });
            return id;
        });

        let html = marked.parse(protected_);

        for (const block of mathBlocks) {
            try {
                const rendered = katex.renderToString(block.tex.trim(), {
                    displayMode: block.display,
                    throwOnError: false,
                    strict: false,
                });
                html = html.replace(block.id, rendered);
            } catch (_) {
                const delim = block.display ? '$$' : '$';
                html = html.replace(block.id, `${delim}${block.tex}${delim}`);
            }
        }

        element.innerHTML = html;

        if (typeof renderMathInElement === 'function') {
            try {
                renderMathInElement(element, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '$', right: '$', display: false },
                        { left: '\\(', right: '\\)', display: false },
                        { left: '\\[', right: '\\]', display: true },
                    ],
                    throwOnError: false,
                });
            } catch (_) { /* ignore */ }
        }
    }

    function renderMessage(role, content, isMarkdown = false) {
        const wrapper = document.createElement('div');
        wrapper.className = `message message--${role === 'user' ? 'user' : 'ai'}`;

        const avatar = document.createElement('div');
        avatar.className = 'message__avatar';
        avatar.innerHTML = role === 'user'
            ? '<i class="ph ph-user" aria-hidden="true"></i>'
            : '<i class="ph ph-sparkle" aria-hidden="true"></i>';

        const bubble = document.createElement('div');
        bubble.className = 'message__bubble';

        if (isMarkdown) {
            renderMarkdownWithMath(bubble, content);
        } else {
            bubble.textContent = content;
        }

        wrapper.appendChild(avatar);
        wrapper.appendChild(bubble);
        el.chatMessages.appendChild(wrapper);
        scrollToBottom();
        return bubble;
    }

    function renderThinking() {
        const div = document.createElement('div');
        div.className = 'thinking-indicator';
        div.id = 'thinking-indicator';
        div.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div><span class="thinking-label">Thinking...</span>`;
        el.chatMessages.appendChild(div);
        scrollToBottom();
    }

    function removeThinking() {
        const t = document.getElementById('thinking-indicator');
        if (t) t.remove();
    }

    function renderError(text) {
        const wrapper = document.createElement('div');
        wrapper.className = 'message message--ai message--error';

        const avatar = document.createElement('div');
        avatar.className = 'message__avatar';
        avatar.style.background = 'var(--color-danger)';
        avatar.innerHTML = '<i class="ph ph-warning" aria-hidden="true"></i>';

        const bubble = document.createElement('div');
        bubble.className = 'message__bubble';
        bubble.textContent = text;

        wrapper.appendChild(avatar);
        wrapper.appendChild(bubble);
        el.chatMessages.appendChild(wrapper);
        scrollToBottom();
    }

    // =====================================================================
    // STREAMING SSE with 503 retry
    // =====================================================================
    const MAX_FRONTEND_RETRIES = 3;

    let currentSources = null; // Store sources for the active stream

    async function streamAIResponse(retryCount = 0) {
        isStreaming = true;
        toggleInputs(true);
        renderThinking();

        abortCtrl = new AbortController();
        let accumulated = '';
        let aiBubble = null;
        currentSources = null;

        const session = getActiveSession();
        if (!session) return;

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    messages: session.messages,
                    document_id: uploadedFileId,
                    deal_room_id: currentDealRoomId
                }),
                signal: abortCtrl.signal,
            });

            // Handle 503 / overloaded
            if (res.status === 503 || res.status === 429) {
                removeThinking();
                if (retryCount < MAX_FRONTEND_RETRIES) {
                    const wait = Math.min(20, 5 * (retryCount + 1));
                    showToast('warning', 'Model busy', `Retrying in ${wait}s (attempt ${retryCount + 1}/${MAX_FRONTEND_RETRIES})...`, wait * 1000);
                    setTimeout(() => streamAIResponse(retryCount + 1), wait * 1000);
                } else {
                    renderError('The AI model is currently overloaded. Please try again in a moment.');
                    finishStream('');
                }
                return;
            }

            if (!res.ok) {
                throw new Error(`Server error: ${res.status} ${res.statusText}`);
            }

            removeThinking();
            aiBubble = renderMessage('ai', '', false);
            aiBubble.classList.add('streaming-cursor');

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const jsonStr = line.slice(6).trim();
                    if (!jsonStr) continue;

                    try {
                        const payload = JSON.parse(jsonStr);

                        if (payload.error) {
                            // Check for overloaded errors in the stream
                            if (/overloaded|503|capacity|quota|resource|unavailable/i.test(payload.error)) {
                                aiBubble.classList.remove('streaming-cursor');
                                if (retryCount < MAX_FRONTEND_RETRIES) {
                                    const wait = Math.min(20, 5 * (retryCount + 1));
                                    showToast('warning', 'Model busy', `Retrying in ${wait}s (attempt ${retryCount + 1}/${MAX_FRONTEND_RETRIES})...`, wait * 1000);
                                    setTimeout(() => streamAIResponse(retryCount + 1), wait * 1000);
                                } else {
                                    renderError('The AI model is currently overloaded. Please try again in a moment.');
                                    finishStream('');
                                }
                                return;
                            }
                            aiBubble.classList.remove('streaming-cursor');
                            renderError(payload.error);
                            finishStream(accumulated);
                            return;
                        }

                        if (payload.done) {
                            aiBubble.classList.remove('streaming-cursor');
                            finishStream(accumulated);
                            return;
                        }

                        if (payload.status === 'searching') {
                            const lbl = document.querySelector('#thinking-indicator .thinking-label');
                            if (lbl) lbl.textContent = 'Searching the web...';
                            continue;
                        }

                        if (payload.sources) {
                            currentSources = payload.sources;
                            const sourcesDiv = document.createElement('div');
                            sourcesDiv.className = 'source-cards';
                            sourcesDiv.innerHTML = currentSources.map(s => {
                                let domain = s.url;
                                try { domain = new URL(s.url).hostname.replace('www.', ''); } catch (e) {}
                                return `
                                    <a href="${s.url}" target="_blank" class="source-card">
                                        <div class="source-card__top">
                                            <img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" alt="${domain}" class="source-card__icon" onerror="this.style.display='none'"/>
                                            <span class="source-card__domain">${domain}</span>
                                        </div>
                                        <div class="source-card__title">${escapeHtml(s.title)}</div>
                                    </a>
                                `;
                            }).join('');
                            
                            // Insert source cards before the message wrapper
                            const wrapper = aiBubble.closest('.message');
                            if (wrapper && wrapper.parentNode) {
                                wrapper.parentNode.insertBefore(sourcesDiv, wrapper);
                            }
                            scrollToBottom();
                            continue;
                        }

                        if (payload.text) {
                            accumulated += payload.text;
                            let textToRender = accumulated;
                            
                            // Replace citations [1], [2] with links
                            if (currentSources && currentSources.length > 0) {
                                textToRender = textToRender.replace(/\[(\d+)\]/g, (match, p1) => {
                                    const idx = parseInt(p1) - 1;
                                    if (idx >= 0 && idx < currentSources.length) {
                                        return `<a href="${currentSources[idx].url}" target="_blank" class="citation" title="${escapeHtml(currentSources[idx].title)}"><span>${p1}</span></a>`;
                                    }
                                    return match;
                                });
                            }
                            
                            renderMarkdownWithMath(aiBubble, textToRender);
                            scrollToBottom();
                        }
                    } catch (_) { /* skip malformed */ }
                }
            }

            if (aiBubble) aiBubble.classList.remove('streaming-cursor');
            finishStream(accumulated);

        } catch (err) {
            removeThinking();
            if (err.name === 'AbortError') {
                if (aiBubble) aiBubble.classList.remove('streaming-cursor');
            } else if (/overloaded|503|fetch/i.test(err.message)) {
                if (retryCount < MAX_FRONTEND_RETRIES) {
                    const wait = Math.min(20, 5 * (retryCount + 1));
                    showToast('warning', 'Model busy', `Retrying in ${wait}s (attempt ${retryCount + 1}/${MAX_FRONTEND_RETRIES})...`, wait * 1000);
                    setTimeout(() => streamAIResponse(retryCount + 1), wait * 1000);
                } else {
                    renderError('Connection failed after multiple attempts. Please try again.');
                    finishStream('');
                }
                return;
            } else {
                renderError(`Connection error: ${err.message}`);
            }
            finishStream(accumulated);
        }
    }

    function finishStream(text) {
        isStreaming = false;
        abortCtrl = null;
        toggleInputs(false);
        if (text) pushMessage('model', text);
        el.chatInput.focus();

        // Update title from first AI response if it's the first exchange
        const session = getActiveSession();
        if (session && session.messages.length === 2) {
            // Use first ~60 chars of user msg as title (already set)
            renderHistoryList();
        }
    }

    // =====================================================================
    // VOICE INPUT — Web Speech API
    // =====================================================================
    function setupVoice() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            // Hide voice buttons if not supported
            el.homeVoiceBtn.style.display = 'none';
            el.chatVoiceBtn.style.display = 'none';
            return;
        }

        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
    }

    function toggleVoice(targetInput, btn) {
        if (!recognition) {
            showToast('error', 'Not Supported', 'Voice input is not supported in this browser.');
            return;
        }

        if (isRecording) {
            recognition.stop();
            return;
        }

        // Start recording
        isRecording = true;
        btn.classList.add('recording');

        recognition.onresult = (event) => {
            let transcript = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            targetInput.value = transcript;
            targetInput.dispatchEvent(new Event('input'));
        };

        recognition.onend = () => {
            isRecording = false;
            btn.classList.remove('recording');
            // Also remove from the other button
            el.homeVoiceBtn.classList.remove('recording');
            el.chatVoiceBtn.classList.remove('recording');
        };

        recognition.onerror = (event) => {
            isRecording = false;
            btn.classList.remove('recording');
            if (event.error !== 'aborted') {
                showToast('error', 'Voice Error', `Speech recognition error: ${event.error}`);
            }
        };

        recognition.start();
    }

    // =====================================================================
    // FILE UPLOAD — PDF RAG
    // =====================================================================
    async function handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        // If in DealRoom, use the DealRoom upload endpoint
        if (currentDealRoomId) {
            uploadToDealRoom(file);
        } else {
            // General Chat Upload — POST to /api/upload immediately
            currentFile = file;
            el.fileBadgeHome.style.display = 'flex';
            el.fileBadgeChat.style.display = 'flex';
            el.fileNameHome.textContent = file.name;
            el.fileNameChat.textContent = file.name;
            showToast('info', 'Uploading...', `Processing ${file.name}...`);

            const formData = new FormData();
            formData.append('file', file);

            try {
                const res = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData
                });
                const data = await res.json();
                if (res.ok && data.document_id) {
                    uploadedFileId = data.document_id;
                    showToast('success', 'File Processed', `${file.name} ready for analysis (${data.chunks} chunks).`);
                } else {
                    showToast('error', 'Upload Failed', data.error || 'Could not process file.');
                    removeFile();
                }
            } catch (err) {
                showToast('error', 'Upload Failed', err.message);
                removeFile();
            }
        }
    }

    async function uploadToDealRoom(file) {
        if (!currentDealRoomId) return;
        el.genOverlay.style.display = 'flex';
        el.genOverlay.querySelector('.gen-text').textContent = 'INGESTING DOCUMENT...';

        const formData = new FormData();
        formData.append('file', file);
        formData.append('deal_room_id', currentDealRoomId);

        try {
            const data = await apiFetch(`/upload`, {
                method: 'POST',
                body: formData
            });
            
            showToast('success', 'Document Ingested', `${file.name} added to repository.`);
            // Refresh the room view to show the new document
            openRoom(currentDealRoomId);
        } catch (err) {
            showToast('error', 'Ingestion Failed', err.message);
        } finally {
            el.genOverlay.style.display = 'none';
            el.genOverlay.querySelector('.gen-text').textContent = 'GENERATING INTELLIGENCE...';
            el.globalFileUpload.value = ''; // Reset file input
        }
    }

    function removeFile() {
        el.globalFileUpload.value = '';
        uploadedFileId = null;
        el.fileBadgeHome.style.display = 'none';
        el.fileBadgeChat.style.display = 'none';
        showToast('info', 'File Removed', 'PDF context has been cleared.');
    }

    // =====================================================================
    // TOAST NOTIFICATIONS
    // =====================================================================
    function showToast(type, title, desc, duration = 5000) {
        const iconMap = {
            warning: 'ph-warning-circle',
            error: 'ph-x-circle',
            success: 'ph-check-circle',
            info: 'ph-info',
        };

        const toast = document.createElement('div');
        toast.className = `toast toast--${type}`;
        toast.innerHTML = `
            <i class="ph ${iconMap[type] || iconMap.info} toast__icon"></i>
            <div class="toast__content">
                <div class="toast__title">${escapeHtml(title)}</div>
                <div class="toast__desc">${escapeHtml(desc)}</div>
            </div>
            <button class="toast__close" aria-label="Close"><i class="ph ph-x"></i></button>
        `;

        const closeBtn = toast.querySelector('.toast__close');
        closeBtn.addEventListener('click', () => removeToast(toast));

        el.toastContainer.appendChild(toast);

        if (duration > 0) {
            setTimeout(() => removeToast(toast), duration);
        }
    }

    function removeToast(toast) {
        if (!toast || !toast.parentNode) return;
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 300);
    }

    // =====================================================================
    // MODAL
    // =====================================================================
    function showConfirmModal() {
        el.confirmModal.style.display = 'flex';
    }

    function hideModal() {
        el.confirmModal.style.display = 'none';
    }

    // =====================================================================
    // DEALROOM LOGIC
    // =====================================================================
    async function apiFetch(endpoint, options = {}) {
        const isFormData = options.body instanceof FormData;
        const headers = { ...options.headers };
        // Only set Content-Type for non-FormData (browser sets multipart boundary automatically)
        if (!isFormData) {
            headers['Content-Type'] = 'application/json';
        }
        if (userToken) headers['Authorization'] = `Bearer ${userToken}`;
        
        const res = await fetch(`${DEALROOM_API}${endpoint}`, { ...options, headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'API Request Failed');
        return data;
    }

    async function loadDealRooms() {
        try {
            const data = await apiFetch('/deal-rooms');
            renderRoomGrid(data.data.rooms);
        } catch (err) {
            showToast('error', 'Failed to load rooms', err.message);
            if (err.message.includes('expired')) logout();
        }
    }

    function renderRoomGrid(rooms) {
        if (!rooms.length) {
            el.roomGrid.innerHTML = `
                <div style="grid-column: 1/-1; text-align: center; padding: 4rem; color: var(--color-text-muted);">
                    <i class="ph ph-folder-open" style="font-size: 3rem; margin-bottom: 1rem; display: block;"></i>
                    <p>No active deal rooms found. Create one to get started.</p>
                </div>
            `;
            return;
        }

        el.roomGrid.innerHTML = rooms.map(room => `
            <div class="room-card" onclick="App.openRoom('${room.id}')">
                <div class="room-card__header">
                    <div class="room-card__icon"><i class="ph ph-briefcase"></i></div>
                    <span class="room-card__status">Active</span>
                </div>
                <div class="room-card__body">
                    <h2>${escapeHtml(room.name)}</h2>
                    <p>${escapeHtml(room.description || 'No description provided.')}</p>
                </div>
                <div class="room-card__footer">
                    <div class="room-card__stat"><i class="ph ph-file"></i> ${room.document_count || 0} Docs</div>
                    <div class="room-card__stat"><i class="ph ph-calendar"></i> ${new Date(room.created_at).toLocaleDateString()}</div>
                </div>
            </div>
        `).join('');
    }

    async function openRoom(id) {
        try {
            const data = await apiFetch(`/deal-rooms/${id}`);
            const room = data.data;
            currentDealRoomId = room.id;
            
            el.activeRoomName.textContent = room.name;
            el.activeRoomDesc.textContent = room.description;
            el.drDashboard.style.display = 'none';
            el.drRoomDetail.style.display = 'block';
            if (el.drTitle) el.drTitle.textContent = 'Room Intelligence';
            
            // Render documents list
            renderRoomDocs(room.documents || []);
            loadReports();
        } catch (err) {
            showToast('error', 'Failed to open room', err.message);
        }
    }

    function renderRoomDocs(docs) {
        const container = document.getElementById('room-docs-list');
        if (!container) return;
        if (!docs || !docs.length) {
            container.innerHTML = `<p style="font-size: var(--fs-xs); color: var(--color-text-muted); padding: 1rem 0;">No documents uploaded yet.</p>`;
            return;
        }
        container.innerHTML = docs.map(d => `
            <div class="report-item">
                <i class="ph ph-file-text report-item__icon"></i>
                <div class="report-item__info">
                    <div class="report-item__title">${escapeHtml(d.filename)}</div>
                    <div class="report-item__date">${d.status} — ${d.chunk_count || 0} chunks</div>
                </div>
            </div>
        `).join('');
    }

    async function handleCreateRoom(e) {
        e.preventDefault();
        const name = $('#room-name').value;
        const description = $('#room-desc').value;

        try {
            await apiFetch('/deal-rooms', {
                method: 'POST',
                body: JSON.stringify({ name, description })
            });
            el.roomModal.style.display = 'none';
            el.roomForm.reset();
            loadDealRooms();
            showToast('success', 'Room Created', `Workspace '${name}' is ready.`);
        } catch (err) {
            showToast('error', 'Creation Failed', err.message);
        }
    }

    function launchRoomAnalysis() {
        if (!currentDealRoomId) return;
        // Keep deal room context active so chat queries go through DealRoom RAG
        const roomName = el.activeRoomName.textContent || 'DealRoom';
        showToast('info', 'AI Analyst Ready', `Now analyzing documents in "${roomName}".`);
        switchMainView('chat');
    }

    // =====================================================================
    // AUTH LOGIC
    // =====================================================================
    function toggleAuthMode() {
        isAuthRegister = !isAuthRegister;
        el.authTitle.textContent = isAuthRegister ? 'Create Account' : 'Welcome to DealRoom';
        el.authDesc.textContent = isAuthRegister ? 'Sign up to start managing high-stakes deals.' : 'Please login to access secure deal workspaces.';
        el.groupName.style.display = isAuthRegister ? 'flex' : 'none';
        el.authSubmitText.textContent = isAuthRegister ? 'Register' : 'Login';
        el.authSwitchText.textContent = isAuthRegister ? 'Already have an account?' : "Don't have an account?";
        el.btnToggleAuth.textContent = isAuthRegister ? 'Login' : 'Register';
    }

    async function handleAuthSubmit(e) {
        e.preventDefault();
        const email = $('#auth-email').value;
        const password = $('#auth-password').value;
        const name = isAuthRegister ? $('#reg-name').value : null;

        const endpoint = isAuthRegister ? '/register' : '/login';
        const body = isAuthRegister ? { email, password, name } : { email, password };

        try {
            const data = await apiFetch(endpoint, {
                method: 'POST',
                body: JSON.stringify(body)
            });

            if (!isAuthRegister && data.data.access_token) {
                userToken = data.data.access_token;
                localStorage.setItem('dr_token', userToken);
                el.authModal.style.display = 'none';
                showToast('success', 'Logged In', `Welcome back, ${data.data.user.name}`);
                switchMainView('dealroom');
            } else if (isAuthRegister) {
                showToast('success', 'Account Created', 'Registration successful. You can now login.');
                toggleAuthMode();
            }
        } catch (err) {
            showToast('error', 'Authentication Failed', err.message);
        }
    }

    function logout() {
        userToken = null;
        localStorage.removeItem('dr_token');
        switchMainView('chat');
        showToast('info', 'Logged Out', 'You have been signed out of DealRoom AI.');
    }

    // =====================================================================
    // HELPERS
    // =====================================================================
    function toggleInputs(disabled) {
        const sendBtns = document.querySelectorAll('.btn-send');
        sendBtns.forEach(b => b.disabled = disabled);
        el.chatInput.disabled = disabled;
    }

    function scrollToBottom() {
        el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
    }

    function autoGrowTextarea(ta) {
        if (!ta) return;
        ta.addEventListener('input', function () {
            this.style.height = 'auto';
            const h = this.scrollHeight;
            this.style.height = `${h}px`;
            this.style.overflowY = h >= 180 ? 'auto' : 'hidden';
        });
    }

    function resetHeight(ta) { ta.style.height = 'auto'; }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // =====================================================================
    // REPORTS LOGIC
    // =====================================================================
    async function handleGenerateReport() {
        if (!currentDealRoomId) return;
        el.genOverlay.style.display = 'flex';

        try {
            const data = await apiFetch('/reports/generate', {
                method: 'POST',
                body: JSON.stringify({ deal_room_id: currentDealRoomId })
            });
            showToast('success', 'Intelligence Mapped', 'Report generated successfully.');
            await loadReports();
            viewReport(data.data.report_id);
        } catch (err) {
            showToast('error', 'Generation Failed', err.message);
        } finally {
            el.genOverlay.style.display = 'none';
        }
    }

    async function loadReports() {
        if (!currentDealRoomId) return;
        try {
            const data = await apiFetch(`/reports?deal_room_id=${currentDealRoomId}`);
            renderReportsList(data.data);
        } catch (err) {
            console.error('Failed to load reports:', err);
        }
    }

    function renderReportsList(reports) {
        if (!reports || !reports.length) {
            el.roomReportsList.innerHTML = `<p style="font-size: var(--fs-xs); color: var(--color-text-muted); padding: 1rem 0;">No reports generated yet.</p>`;
            return;
        }

        el.roomReportsList.innerHTML = reports.map(r => `
            <div class="report-item" onclick="App.viewReport('${r.id}')">
                <i class="ph ph-file-text report-item__icon"></i>
                <div class="report-item__info">
                    <div class="report-item__title">Due Diligence Report</div>
                    <div class="report-item__date">${new Date(r.created_at).toLocaleString()}</div>
                </div>
                <i class="ph ph-caret-right" style="color:var(--color-text-muted)"></i>
            </div>
        `).join('');
    }

    async function viewReport(id) {
        try {
            const data = await apiFetch(`/reports/${id}?deal_room_id=${currentDealRoomId}`);
            const report = data.data;
            
            // Render markdown
            el.reportMdContent.innerHTML = marked.parse(report.report_data || 'No content available.');
            el.reportModal.style.display = 'flex';
            
            // Store raw data for copy/download
            el.reportModal.dataset.raw = report.report_data || '';
            el.reportModal.dataset.filename = `DD_Report_${(report.company_name || 'Unknown').replace(/\s+/g, '_')}_${id.slice(0,5)}.md`;
        } catch (err) {
            showToast('error', 'Failed to view report', err.message);
        }
    }

    function copyReportToClipboard() {
        const text = el.reportModal.dataset.raw;
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            showToast('success', 'Copied', 'Markdown copied to clipboard.');
        });
    }

    function downloadReportAsMarkdown() {
        const text = el.reportModal.dataset.raw;
        const filename = el.reportModal.dataset.filename;
        if (!text) return;

        const blob = new Blob([text], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || 'DD_Report.md';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // =====================================================================
    // TRENDS & CHARTS LOGIC
    // =====================================================================
    async function handleViewTrends() {
        if (!currentDealRoomId) return;
        el.genOverlay.style.display = 'flex';

        try {
            const data = await apiFetch(`/deal-rooms/${currentDealRoomId}/trends`);
            const metrics = data.data.metrics;
            
            if (Object.keys(metrics).length === 0) {
                showToast('info', 'No Data Found', 'Upload a financial PDF to see trends.');
                return;
            }

            el.trendsModal.style.display = 'flex';
            renderFinancialCharts(metrics);
        } catch (err) {
            showToast('error', 'Analysis Failed', err.message);
        } finally {
            el.genOverlay.style.display = 'none';
        }
    }

    function renderFinancialCharts(metrics) {
        // Destroy existing charts if any
        Object.values(el.charts).forEach(c => c.destroy());

        // Find primary metrics
        const revenueKey = Object.keys(metrics).find(k => k.toLowerCase().includes('revenue'));
        const ebitdaKey = Object.keys(metrics).find(k => k.toLowerCase().includes('ebitda'));

        if (revenueKey) {
            const revData = metrics[revenueKey];
            el.charts.revenue = new Chart(el.chartRevenue, {
                type: 'line',
                data: {
                    labels: revData.periods,
                    datasets: [{
                        label: revenueKey,
                        data: revData.raw_values,
                        borderColor: '#8b5cf6',
                        backgroundColor: 'rgba(139, 92, 246, 0.1)',
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: getChartOptions(`CAGR: ${revData.cagr.toFixed(1)}%`)
            });
        }

        if (ebitdaKey) {
            const ebitdaData = metrics[ebitdaKey];
            el.charts.ebitda = new Chart(el.chartEbitda, {
                type: 'bar',
                data: {
                    labels: ebitdaData.periods,
                    datasets: [{
                        label: ebitdaKey,
                        data: ebitdaData.raw_values,
                        backgroundColor: 'rgba(56, 189, 248, 0.6)',
                        borderRadius: 6
                    }]
                },
                options: getChartOptions(`Trend: ${ebitdaData.trend}`)
            });
        }
    }

    function getChartOptions(subtitle) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                title: {
                    display: true,
                    text: subtitle,
                    color: '#94a3b8',
                    font: { size: 12, weight: '400' },
                    padding: { bottom: 10 }
                }
            },
            scales: {
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#64748b' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#64748b' }
                }
            }
        };
    }

    // =====================================================================
    // PUBLIC
    // =====================================================================
    return { init, openRoom, viewReport };
})();
