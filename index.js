import { sha256, yaml } from '/lib.js';

const settingName = 'uncutReplyCache';
const defaults = {
    bridgeUrl: 'http://127.0.0.1:8765/v1',
    backups: 2,
    ignoreLast: 0,
    ignoreSystem: false,
};
const clientId = Array.from(crypto.getRandomValues(new Uint8Array(16)));
const promptSnapshots = new WeakMap();

function integer(value, max) {
    return Math.min(Math.max(Math.trunc(Number(value)) || 0, 0), max);
}

function endpoint(value) {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            return null;
        }
        return url.href.replace(/\/+$/, '');
    } catch {
        return null;
    }
}

function systemSources(context, card) {
    const settings = context.chatCompletionSettings;
    const powerUser = context.powerUserSettings;
    return {
        prompts: settings.prompts?.filter(prompt => !['worldInfoBefore', 'worldInfoAfter'].includes(prompt.identifier)),
        promptOrder: settings.prompt_order,
        opening: settings.new_chat_prompt,
        formats: [settings.scenario_format, settings.personality_format],
        card: [card?.description, card?.personality, card?.scenario, card?.system_prompt,
            card?.post_history_instructions, card?.mes_example, card?.extensions?.depth_prompt],
        prefer: [powerUser?.prefer_character_prompt, powerUser?.prefer_character_jailbreak],
        persona: [powerUser?.persona_description, powerUser?.persona_description_position,
            powerUser?.persona_description_depth, powerUser?.persona_description_role],
        note: [context.chatMetadata?.note_prompt, context.chatMetadata?.note_position,
            context.chatMetadata?.note_depth, context.chatMetadata?.note_interval, context.chatMetadata?.note_role],
    };
}

function snapshot(context, settings) {
    const chatId = context.getCurrentChatId();
    const character = context.characters?.[context.characterId];
    if (!chatId || !character || context.groupId) return null;
    // 从原始聊天和未展开的设定取值，世界书即便被注入为 user 或 assistant 也不会参与哈希。
    const history = context.chat.filter(message => !message.is_system).map(message => [
        message.is_user, message.name, message.mes, message.extra?.media, message.extra?.file,
        message.extra?.reasoning, message.extra?.bias,
    ]);
    return {
        scope: [character.avatar, chatId],
        names: [context.name1, context.name2],
        history,
        system: settings.ignoreSystem ? null : systemSources(context, character.data),
    };
}

function attachCache(data, settings) {
    if (!data || data.chat_completion_source !== 'custom') return;
    if (![undefined, 'normal', 'swipe', 'regenerate'].includes(data.type)) return;
    const backups = integer(settings.backups, 4);
    const bridge = endpoint(settings.bridgeUrl);
    if (!backups || !bridge || endpoint(data.custom_url) !== bridge) return;
    const current = promptSnapshots.get(data.messages?.[0]);
    if (!current) return;

    const history = current.history;
    // 下一条仍保留上一条模型回复；重新生成时酒馆已经把那条回复从聊天里移除了。
    const length = data.type === 'swipe' ? Math.max(0, history.length - 1) : history.length;
    if (!length) return;
    const ignored = integer(settings.ignoreLast, 1000);
    const key = sha256(JSON.stringify([
        clientId, current.scope, current.names, current.system, Boolean(settings.ignoreSystem),
        length, ignored, history.slice(0, Math.max(0, length - ignored)),
    ]));

    try {
        const existing = yaml.parse(data.custom_include_body || '{}') ?? {};
        if (typeof existing !== 'object' || Array.isArray(existing) || Object.hasOwn(existing, 'messages')) return;
        data.custom_include_body = yaml.stringify({ ...existing, _uncut_cache: { key, backups } });
    } catch {
        console.warn('并行回复缓存：无法解析自定义请求体，已跳过此次缓存');
    }
}

function addSettingsPanel(context, settings) {
    const container = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!container) return;
    const panel = document.createElement('details');
    panel.className = 'marginBot5';
    panel.innerHTML = `
        <summary>并行回复缓存</summary>
        <label>桥接地址<input class="text_pole" type="url" data-setting="bridgeUrl"></label>
        <label>缓存响应（不含首条，0 关闭）<input class="text_pole" type="number" min="0" max="4" data-setting="backups"></label>
        <label>不哈希最后 N 条消息<input class="text_pole" type="number" min="0" max="1000" data-setting="ignoreLast"></label>
        <label class="checkbox_label"><input type="checkbox" data-setting="ignoreSystem">不哈希系统消息</label>
        <small>世界书始终不参与缓存匹配，实际发给模型的内容不变。</small>`;
    for (const input of panel.querySelectorAll('[data-setting]')) {
        const name = input.dataset.setting;
        if (input.type === 'checkbox') input.checked = settings[name];
        else input.value = settings[name];
        input.addEventListener('change', () => {
            if (input.type === 'checkbox') settings[name] = input.checked;
            else if (input.type === 'number') input.value = settings[name] = integer(input.value, Number(input.max));
            else settings[name] = input.value.trim();
            context.saveSettingsDebounced();
        });
    }
    container.append(panel);
}

jQuery(() => {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[settingName] = {
        ...defaults, ...context.extensionSettings[settingName],
    };
    addSettingsPanel(context, settings);
    const { eventSource, eventTypes } = context;
    if (!eventTypes.CHAT_COMPLETION_PROMPT_READY || !eventTypes.CHAT_COMPLETION_SETTINGS_READY) {
        console.warn('并行回复缓存：当前酒馆版本缺少所需的聊天补全事件');
        return;
    }
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, ({ chat, dryRun }) => {
        if (dryRun || !settings.backups || !chat?.[0]) return;
        const current = SillyTavern.getContext();
        if (current.chatCompletionSettings?.chat_completion_source !== 'custom'
            || endpoint(current.chatCompletionSettings.custom_url) !== endpoint(settings.bridgeUrl)) return;
        const state = snapshot(current, settings);
        if (state) promptSnapshots.set(chat[0], state);
    });
    eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, data => attachCache(data, settings));
});
