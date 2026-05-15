// @ts-check
(function () {
    'use strict';

    const MODULE_NAME = 'token_optimizer';
    const DISPLAY_NAME = 'Token Optimizer';

    // =========================================================================
    //  DEFAULTS
    // =========================================================================
    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        clean_hangul: true,
        trim_infoblock: true,
        hide_bracket_msgs: true,
        protected_ai_count: 3,
        protected_user_count: 2,
    });

    // =========================================================================
    //  SETTINGS
    // =========================================================================
    function getSettings() {
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings[MODULE_NAME]) {
            ctx.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
        }
        const s = ctx.extensionSettings[MODULE_NAME];
        // Forward-compat: fill in any keys added in future versions
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
            if (s[k] === undefined) s[k] = v;
        }
        return s;
    }

    function saveSettings() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    // =========================================================================
    //  CONTENT ACCESSORS  (handles string vs. multimodal content array)
    // =========================================================================
    /**
     * @param {string|Array<{type:string,text?:string}>} content
     * @returns {string}
     */
    function getText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            const part = content.find(p => p.type === 'text');
            return (part && part.text) ? part.text : '';
        }
        return '';
    }

    /**
     * @param {{content: string|Array}} msg
     * @param {string} text
     */
    function setText(msg, text) {
        if (typeof msg.content === 'string') {
            msg.content = text;
        } else if (Array.isArray(msg.content)) {
            const part = msg.content.find(p => p.type === 'text');
            if (part) part.text = text;
        }
    }

    // =========================================================================
    //  FEATURE 1 — Remove U+3164 (Hangul Filler)
    // =========================================================================
    const RE_HANGUL = /\u3164/g;

    /** @param {string} text @returns {string} */
    function cleanHangul(text) {
        return text.replace(RE_HANGUL, ' ');
    }

    // =========================================================================
    //  FEATURE 2 — Trim <infoblock>: keep only GENERAL STATS → SCENE DETAILS
    // =========================================================================

    /**
     * Given the raw inner text of an <infoblock>, extracts lines from the
     * "GENERAL STATS" heading up to (not including) the "SCENE DETAILS" heading.
     * Returns null when the expected markers are not found (block left untouched).
     *
     * @param {string} inner
     * @returns {string|null}
     */
    function extractStatSection(inner) {
        const lines = inner.split('\n');
        let gsLine = -1;
        let sdLine = -1;

        for (let i = 0; i < lines.length; i++) {
            if (gsLine === -1 && /GENERAL\s+STATS/i.test(lines[i])) gsLine = i;
            if (sdLine === -1 && /SCENE\s+DETAILS/i.test(lines[i]))  sdLine = i;
        }

        if (gsLine === -1 || sdLine === -1 || sdLine <= gsLine) return null;

        // Take GENERAL STATS heading + its content, trim trailing blank lines
        const section = lines.slice(gsLine, sdLine);
        while (section.length > 0 && section[section.length - 1].trim() === '') {
            section.pop();
        }
        return section.join('\n');
    }

    /** @param {string} text @returns {string} */
    function trimInfoblock(text) {
        return text.replace(/<infoblock>([\s\S]*?)<\/infoblock>/gi, function (match, inner) {
            const extracted = extractStatSection(inner);
            if (extracted === null) return match; // markers not found — leave as-is
            return '<infoblock>\n' + extracted + '\n</infoblock>';
        });
    }

    // =========================================================================
    //  FEATURE 3 — Hide old pure-bracket user messages  [TIMESKIP …]
    // =========================================================================

    // Matches any mix of Latin/Cyrillic "OOC" at the start of a bracket block
    const RE_OOC = /^\s*\[[OoОо][OoОо][CcСс]\s*:/;

    /**
     * Returns true when the *entire* message consists only of one or more
     * bracket blocks — nothing outside them.
     *
     * Case 1 → "[ТАЙМСКИП — ДВАДЦАТЬ МИНУТ]"          → true  (remove)
     * Case 2 → "[ТАЙМСКИП]\n\nВивьен спустилась…"     → false (keep)
     * Case 3 → "[block1]\n[block2]"                    → true  (remove)
     *
     * @param {string} text
     * @returns {boolean}
     */
    function isPureBracketMsg(text) {
        const trimmed = text.trim();
        if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return false;
        // Strip ALL bracket blocks; if nothing meaningful remains → pure
        const outside = trimmed.replace(/\[[\s\S]*?\]/g, '').trim();
        return outside.length === 0;
    }

    /**
     * OOC brackets are always kept, regardless of position.
     * @param {string} text
     * @returns {boolean}
     */
    function isOoc(text) {
        return RE_OOC.test(text.trim());
    }

    // =========================================================================
    //  CORE — prompt interceptor
    // =========================================================================

    /**
     * Called by CHAT_COMPLETION_PROMPT_READY with the messages array
     * that is about to be sent to the API.  We modify it in-place.
     *
     * @param {{chat: Array<{role:string, content:string|Array}>}} data
     */
    function processPrompt(data) {
        // Defensive: handle both {chat} shape and bare array (older ST builds)
        const chat = Array.isArray(data) ? data : (data && data.chat);
        if (!Array.isArray(chat) || chat.length === 0) return;

        const s = getSettings();
        if (!s.enabled) return;

        // ── Build ordered index lists ──────────────────────────────────────────
        /** @type {number[]} */
        const aiIdx   = [];
        /** @type {number[]} */
        const userIdx = [];

        for (let i = 0; i < chat.length; i++) {
            const role = chat[i].role;
            if (role === 'assistant') aiIdx.push(i);
            else if (role === 'user') userIdx.push(i);
        }

        // Last N messages of each role are "protected" (keep full content)
        const protectedAi   = new Set(aiIdx.slice(  -(s.protected_ai_count   || 3)));
        const protectedUser = new Set(userIdx.slice(-(s.protected_user_count || 2)));

        /** @type {number[]} */
        const toRemove = [];

        // ── Process each message ───────────────────────────────────────────────
        for (let i = 0; i < chat.length; i++) {
            const msg  = chat[i];
            let   text = getText(msg.content);

            // 1. Clean U+3164 — user messages always, AI messages except the last one
            if (s.clean_hangul) {
                const isLastAi = msg.role === 'assistant' && i === aiIdx[aiIdx.length - 1];
                if (!isLastAi) {
                    text = cleanHangul(text);
                }
            }

            // 2. Trim <infoblock> in unprotected AI messages
            if (s.trim_infoblock && msg.role === 'assistant' && !protectedAi.has(i)) {
                text = trimInfoblock(text);
            }

            // 3. Remove pure-bracket user messages outside the protected window
            if (s.hide_bracket_msgs && msg.role === 'user' && !protectedUser.has(i)) {
                if (isPureBracketMsg(text) && !isOoc(text)) {
                    toRemove.push(i);
                    continue; // Don't write back — message will be spliced out
                }
            }

            setText(msg, text);
        }

        // ── Remove flagged messages (reverse order preserves indices) ──────────
        for (let i = toRemove.length - 1; i >= 0; i--) {
            chat.splice(toRemove[i], 1);
        }
    }

    // =========================================================================
    //  SETTINGS UI
    // =========================================================================
    function initUI() {
        const s = getSettings();

        const html = `
        <div id="${MODULE_NAME}-settings" class="extension_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>✂ ${DISPLAY_NAME}</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" style="display:flex; flex-direction:column; gap:8px;">

                    <label class="checkbox_label">
                        <input id="to-enabled" type="checkbox" ${s.enabled ? 'checked' : ''}>
                        <span>Расширение включено</span>
                    </label>

                    <hr class="to-divider">

                    <label class="checkbox_label">
                        <input id="to-hangul" type="checkbox" ${s.clean_hangul ? 'checked' : ''}>
                        <span>Удалять <code>ㅤ</code> (U+3164) из payload</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="to-infoblock" type="checkbox" ${s.trim_infoblock ? 'checked' : ''}>
                        <span>Сжимать <code>&lt;infoblock&gt;</code> в старых ответах ИИ</span>
                    </label>

                    <div class="to-sub-row">
                        <span class="to-sub-label">Не трогать последние</span>
                        <input id="to-ai-count" type="number" class="text_pole to-num-input"
                            value="${s.protected_ai_count}" min="1" max="30">
                        <span class="to-sub-label">ответов ИИ</span>
                    </div>

                    <label class="checkbox_label">
                        <input id="to-bracket" type="checkbox" ${s.hide_bracket_msgs ? 'checked' : ''}>
                        <span>Скрывать старые <code>[ТАЙМСКИПЫ]</code> из payload</span>
                    </label>

                    <div class="to-sub-row">
                        <span class="to-sub-label">Не трогать последние</span>
                        <input id="to-user-count" type="number" class="text_pole to-num-input"
                            value="${s.protected_user_count}" min="1" max="30">
                        <span class="to-sub-label">сообщений юзера</span>
                    </div>

                    <hr class="to-divider">

                    <div class="to-hint">
                        Правила: <code>[OOC: …]</code> не удаляются. Если в сообщении юзера есть
                        текст вне скобок — оно не считается "чистым" и не удаляется.
                        Все изменения только в API payload; чат в UI не меняется.
                    </div>

                </div>
            </div>
        </div>`;

        $('#extensions_settings').append(html);

        // ── Bindings ───────────────────────────────────────────────────────────
        $('#to-enabled').on('change', function () {
            s.enabled = /** @type {HTMLInputElement} */ (this).checked;
            saveSettings();
        });

        $('#to-hangul').on('change', function () {
            s.clean_hangul = /** @type {HTMLInputElement} */ (this).checked;
            saveSettings();
        });

        $('#to-infoblock').on('change', function () {
            s.trim_infoblock = /** @type {HTMLInputElement} */ (this).checked;
            saveSettings();
        });

        $('#to-ai-count').on('change', function () {
            const v = parseInt(/** @type {HTMLInputElement} */ (this).value, 10);
            s.protected_ai_count = Math.max(1, Math.min(30, isNaN(v) ? 3 : v));
            /** @type {HTMLInputElement} */ (this).value = String(s.protected_ai_count);
            saveSettings();
        });

        $('#to-bracket').on('change', function () {
            s.hide_bracket_msgs = /** @type {HTMLInputElement} */ (this).checked;
            saveSettings();
        });

        $('#to-user-count').on('change', function () {
            const v = parseInt(/** @type {HTMLInputElement} */ (this).value, 10);
            s.protected_user_count = Math.max(1, Math.min(30, isNaN(v) ? 2 : v));
            /** @type {HTMLInputElement} */ (this).value = String(s.protected_user_count);
            saveSettings();
        });
    }

    // =========================================================================
    //  INIT
    // =========================================================================
    $(document).ready(function () {
        const ctx = SillyTavern.getContext();

        ctx.eventSource.on(ctx.event_types.APP_READY, function () {
            try {
                initUI();
                console.log('[' + DISPLAY_NAME + '] loaded.');
            } catch (err) {
                console.error('[' + DISPLAY_NAME + '] init error:', err);
                toastr.error(String(err.message), DISPLAY_NAME, { timeOut: 8000 });
            }
        });

        // Hook into the chat-completion pipeline.
        // CHAT_COMPLETION_PROMPT_READY fires after messages[] is assembled
        // but before the HTTP request is sent — we get a mutable reference.
        if (ctx.event_types.CHAT_COMPLETION_PROMPT_READY) {
            ctx.eventSource.on(ctx.event_types.CHAT_COMPLETION_PROMPT_READY, processPrompt);
        } else {
            console.warn('[' + DISPLAY_NAME + '] CHAT_COMPLETION_PROMPT_READY not found in this ST build.');
        }
    });

})();
