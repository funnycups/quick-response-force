// 快速响应部队 - 世界书处理模块
// 由Cline移植并重构，核心功能来自Amily2号插件

import { safeCharLorebooks, safeLorebookEntries } from './tavernhelper-compatibility.js';
import { checkWorldInfo, loadWorldInfo, worldInfoCache, world_info_include_names, world_info } from '/scripts/world-info.js';
import { characters, chat_metadata, extension_prompt_roles, extension_prompt_types, getCharacterCardFields, this_chid } from '/script.js';
import { power_user } from '/scripts/power-user.js';
import { getCharaFilename } from '/scripts/utils.js';
import { NOTE_MODULE_NAME } from '/scripts/authors-note.js';

/**
 * 提取并合并当前角色所有关联世界书的内容，并根据新的、支持递归的筛选逻辑进行处理。
 * 
 * @param {object} context - SillyTavern的上下文对象.
 * @param {object} apiSettings - 插件的API设置.
 * @param {string} userMessage - 本次待发送的用户消息（在 hook 阶段可能尚未写入 chat 历史）。
 * @param {string} [generationType='normal'] - SillyTavern generation type（用于 WI triggers）。
 * @returns {Promise<string>} - 返回一个包含所有最终触发的世界书条目内容的字符串。
 */
export async function getCombinedWorldbookContent(context, apiSettings, userMessage, generationType = 'normal') {
    // [架构重构 & 功能更新] 始终使用传入的、已经合并好的apiSettings作为唯一数据源，不再从UI面板读取。
    // 这确保了无论UI是否打开，核心逻辑都使用一致且正确的设置。

    if (!apiSettings.worldbookEnabled) {
        return '';
    }

    if (!context) {
        console.warn('[剧情优化大师] Context 未提供，无法获取世界书内容。');
        return '';
    }

    const normalizeWorldNames = (names) =>
        [...new Set((Array.isArray(names) ? names : []).map(x => String(x || '').trim()).filter(Boolean))];

    const parseRegexFromSettingLine = (line) => {
        const text = String(line || '').trim();
        if (!text) return null;

        // Support `/pattern/flags` form
        const literalMatch = text.match(/^\/([\s\S]+)\/([a-z]*)$/i);
        if (literalMatch) {
            try {
                return new RegExp(literalMatch[1], literalMatch[2] || 'g');
            } catch (e) {
                console.warn('[剧情优化大师] 世界书剔除正则解析失败（regex literal）:', text, e);
                return null;
            }
        }

        // Otherwise treat as a pattern with default `g`.
        try {
            return new RegExp(text, 'g');
        } catch (e) {
            console.warn('[剧情优化大师] 世界书剔除正则解析失败（pattern）:', text, e);
            return null;
        }
    };

    const stripConfiguredWorldInfoContent = (rawWorldInfoString) => {
        let text = String(rawWorldInfoString || '');
        if (!text) return '';

        if (!apiSettings?.worldbookStripEnabled) {
            return text;
        }

        const patternsValue = apiSettings.worldbookStripPatterns;
        const lines = Array.isArray(patternsValue)
            ? patternsValue
            : String(patternsValue || '').split('\n');

        for (const line of lines) {
            const regex = parseRegexFromSettingLine(line);
            if (!regex) continue;
            text = text.replace(regex, '\n');
        }

        // Cleanup excessive blank lines after removals
        text = text.replace(/\r\n/g, '\n');
        text = text.replace(/\n{3,}/g, '\n\n').trim();
        return text;
    };

    const applyWorldbookLimit = (text) => {
        const content = String(text || '');
        if (!content) return '';

        // [修复] 支持设为0来禁用字符限制
        const limit = apiSettings.worldbookCharLimit !== undefined
            ? apiSettings.worldbookCharLimit
            : 60000;

        if (limit > 0 && content.length > limit) {
            console.log(`[剧情优化大师] 世界书内容 (${content.length} chars) 超出限制 (${limit} chars)，将被截断。`);
            return content.substring(0, limit);
        }

        return content;
    };

    const getActiveScriptInjectPrompts = async () => {
        // SillyTavern 的 /listinjects 展示的是当前聊天的 script injections（chat_metadata.script_injects）。
        // 本插件绕过 ST 的 sendGenerationRequest 流程，因此需要手动把这些注入拼进最终提示词里。
        const meta = context?.chatMetadata ?? chat_metadata;
        const injects = meta?.script_injects;
        if (!injects || typeof injects !== 'object') return '';

        const extPrompts = context?.extensionPrompts && typeof context.extensionPrompts === 'object'
            ? context.extensionPrompts
            : {};

        const positionName = (position) => {
            const entries = Object.entries(extension_prompt_types || {});
            return entries.find(([_, value]) => value === position)?.[0] ?? String(position ?? 'unknown');
        };

        const roleName = (role) => {
            switch (role) {
                case extension_prompt_roles?.USER:
                    return 'user';
                case extension_prompt_roles?.ASSISTANT:
                    return 'assistant';
                case extension_prompt_roles?.SYSTEM:
                default:
                    return 'system';
            }
        };

        /** @type {{id:string,value:string,position:number,depth:number,scan:boolean,role:number}[]} */
        const active = [];

        for (const [id, raw] of Object.entries(injects)) {
            const prefixedId = `script_inject_${id}`;
            const prompt = extPrompts?.[prefixedId];

            const value = String(prompt?.value ?? raw?.value ?? '').trim();
            if (!value) continue;

            // 若注入带有 filter（闭包），尽量对齐 ST 的行为：filter 为 false 时不注入。
            if (prompt?.filter) {
                try {
                    const ok = await prompt.filter();
                    if (!ok) continue;
                } catch (e) {
                    console.warn('[qrf] Script inject filter 执行失败，将跳过该 inject:', id, e);
                    continue;
                }
            }

            const position = Number(prompt?.position ?? raw?.position ?? extension_prompt_types?.IN_PROMPT ?? 0);
            const depth = Number(prompt?.depth ?? raw?.depth ?? 0);
            const scan = !!(prompt?.scan ?? raw?.scan ?? false);
            const role = Number(prompt?.role ?? raw?.role ?? extension_prompt_roles?.SYSTEM ?? 0);

            active.push({ id: String(id), value, position, depth, scan, role });
        }

        if (active.length === 0) {
            console.debug('[qrf] Script injects detected but none are active (empty/filtered).');
            return '';
        }

        console.debug('[qrf] Active script injects:', active.map(x => x.id));

        // 以“世界书条目”风格输出，避免丢失上下文来源信息。
        const blocks = active.map((x) => {
            const metaLine = `[inject:${x.id} | ${positionName(x.position)} | depth:${x.depth} | scan:${x.scan} | role:${roleName(x.role)}]`;
            return `${metaLine}\n${x.value}`;
        });

        return `【Additional Info】\n\n${blocks.join('\n\n---\n\n')}`.trim();
    };

    try {
        const scriptInjectContent = await getActiveScriptInjectPrompts();
        const scriptInjectFinal = applyWorldbookLimit(stripConfiguredWorldInfoContent(scriptInjectContent));

        let bookNames = [];
        
        if (apiSettings.worldbookSource === 'manual') {
            // 仅使用手动选择的世界书
            bookNames = normalizeWorldNames(apiSettings.selectedWorldbooks);
            if (bookNames.length === 0) return scriptInjectFinal;
        } else if (apiSettings.worldbookSource === 'both') {
            // 同时使用角色卡世界书和额外指定的世界书
            const charLorebooks = await safeCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
            
            // 添加额外指定的世界书
            bookNames.push(...normalizeWorldNames(apiSettings.additionalWorldbooks));
            bookNames = normalizeWorldNames(bookNames);
            
            if (bookNames.length === 0) return scriptInjectFinal;
        } else {
            // 默认：仅使用角色卡绑定的世界书
            const charLorebooks = await safeCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
            bookNames = normalizeWorldNames(bookNames);
            if (bookNames.length === 0) return scriptInjectFinal;
        }

        const tryGetWorldbookContentViaOfficialWI = async () => {
            if (typeof checkWorldInfo !== 'function') {
                return null;
            }

            // 在不修改/保存 SillyTavern 全局“已激活世界书列表”的前提下，临时把要扫描的世界书挂到“当前角色世界书 + 额外世界书”上。
            // 这样可以让 checkWorldInfo/getSortedEntries 把这些世界书加载进扫描集合里。
            const chid = typeof this_chid === 'number' ? this_chid : context.characterId;
            const character = characters?.[chid];
            const originalCharacterWorld = character?.data?.extensions?.world;
            const hadCharLore = !!(world_info && Object.hasOwn(world_info, 'charLore'));
            const originalCharLore = hadCharLore ? structuredClone(world_info.charLore) : undefined;
            const originalChatWorld = chat_metadata?.world_info;
            const originalPersonaWorld = power_user?.persona_description_lorebook ?? null;
            const originalWorldInfoCache = new Map();
            const originalWorldInfoCacheMisses = new Set();
            const hadTimedWorldInfo = !!(chat_metadata && Object.prototype.hasOwnProperty.call(chat_metadata, 'timedWorldInfo'));
            const originalTimedWorldInfo = hadTimedWorldInfo ? structuredClone(chat_metadata.timedWorldInfo) : undefined;
            const hadOriginalNotePrompt = !!(context?.extensionPrompts && Object.prototype.hasOwnProperty.call(context.extensionPrompts, NOTE_MODULE_NAME));
            const originalNotePrompt = hadOriginalNotePrompt ? structuredClone(context.extensionPrompts[NOTE_MODULE_NAME]) : undefined;

            const restore = () => {
                // 还原临时修改的 world info 缓存（用于实现“即便 ST 里启用，也可在插件里禁用条目”）
                if (worldInfoCache && typeof worldInfoCache.set === 'function') {
                    for (const [worldName, original] of originalWorldInfoCache.entries()) {
                        worldInfoCache.set(worldName, original);
                    }
                    for (const worldName of originalWorldInfoCacheMisses) {
                        if (typeof worldInfoCache.delete === 'function') {
                            worldInfoCache.delete(worldName);
                        }
                    }
                }

                if (chat_metadata && Object.prototype.hasOwnProperty.call(chat_metadata, 'world_info')) {
                    chat_metadata.world_info = originalChatWorld;
                }
                if (chat_metadata) {
                    if (hadTimedWorldInfo) {
                        chat_metadata.timedWorldInfo = originalTimedWorldInfo;
                    } else if (Object.prototype.hasOwnProperty.call(chat_metadata, 'timedWorldInfo')) {
                        delete chat_metadata.timedWorldInfo;
                    }
                }
                if (power_user && Object.prototype.hasOwnProperty.call(power_user, 'persona_description_lorebook')) {
                    power_user.persona_description_lorebook = originalPersonaWorld;
                }
                if (character?.data?.extensions) {
                    character.data.extensions.world = originalCharacterWorld;
                }
                if (world_info) {
                    if (hadCharLore) {
                        world_info.charLore = originalCharLore;
                    } else if (Object.hasOwn(world_info, 'charLore')) {
                        delete world_info.charLore;
                    }
                }
                if (context?.extensionPrompts) {
                    if (hadOriginalNotePrompt) {
                        context.extensionPrompts[NOTE_MODULE_NAME] = originalNotePrompt;
                    } else if (Object.prototype.hasOwnProperty.call(context.extensionPrompts, NOTE_MODULE_NAME)) {
                        delete context.extensionPrompts[NOTE_MODULE_NAME];
                    }
                }
            };

            try {
                console.debug('[qrf] Using SillyTavern official WI scan for:', bookNames);

                // 默认行为保持与本插件旧逻辑一致：不额外扫描“聊天世界书 / 人设世界书”来源。
                if (chat_metadata && Object.prototype.hasOwnProperty.call(chat_metadata, 'world_info')) {
                    chat_metadata.world_info = null;
                }
                if (power_user && Object.prototype.hasOwnProperty.call(power_user, 'persona_description_lorebook')) {
                    power_user.persona_description_lorebook = null;
                }

                // 将 bookNames 临时挂到角色身上：base + extraBooks
                if (character?.data?.extensions) {
                    character.data.extensions.world = bookNames[0] ?? null;
                }
                if (world_info) {
                    const fileName = getCharaFilename(chid);
                    const extraBooks = bookNames.slice(1);
                    const nextCharLore = Array.isArray(originalCharLore) ? structuredClone(originalCharLore) : [];
                    const idx = nextCharLore.findIndex(e => e?.name === fileName);

                    if (fileName) {
                        if (extraBooks.length === 0) {
                            if (idx !== -1) nextCharLore.splice(idx, 1);
                        } else if (idx === -1) {
                            nextCharLore.push({ name: fileName, extraBooks });
                        } else {
                            nextCharLore[idx] = { ...nextCharLore[idx], extraBooks };
                        }
                    }

                    world_info.charLore = nextCharLore;
                }

                // 让“插件禁用条目”在官方扫描阶段也生效：临时把对应 uid 设为 disable=true
                const disabledEntriesMap = apiSettings.disabledWorldbookEntries || {};
                if (worldInfoCache && typeof worldInfoCache.has === 'function') {
                    for (const worldName of bookNames) {
                        const disabledUids = disabledEntriesMap[worldName];
                        if (!Array.isArray(disabledUids) || disabledUids.length === 0) continue;

                        const wasCached = worldInfoCache.has(worldName);
                        if (wasCached) {
                            originalWorldInfoCache.set(worldName, worldInfoCache.get(worldName));
                        } else {
                            originalWorldInfoCacheMisses.add(worldName);
                        }

                        const data = await loadWorldInfo(worldName);
                        if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') continue;

                        const modified = structuredClone(data);
                        for (const uidRaw of disabledUids) {
                            const uidNum = typeof uidRaw === 'number' ? uidRaw : Number(uidRaw);
                            if (Number.isNaN(uidNum)) continue;
                            const key = String(uidNum);
                            if (modified.entries[key]) {
                                modified.entries[key] = { ...modified.entries[key], disable: true };
                            }
                        }

                        worldInfoCache.set(worldName, modified);
                    }
                }

                const fields = getCharacterCardFields({ chid });
                const globalScanData = {
                    personaDescription: fields?.persona || '',
                    characterDescription: fields?.description || '',
                    characterPersonality: fields?.personality || '',
                    characterDepthPrompt: fields?.charDepthPrompt || '',
                    scenario: fields?.scenario || '',
                    creatorNotes: fields?.creatorNotes || '',
                    trigger: typeof generationType === 'string' && generationType.length > 0 ? generationType : 'normal',
                };

                // 尽量对齐 ST 的 coreChat：保留非 system；system 仅保留工具调用相关消息。
                const coreChat = Array.isArray(context.chat)
                    ? context.chat.filter(x => !x?.is_system || Array.isArray(x?.extra?.tool_invocations))
                    : [];
                const pendingUserMessage = String(userMessage || '').trim();
                const userDisplayName = context?.name1 || 'You';
                const pendingScanText = world_info_include_names ? `${userDisplayName}: ${pendingUserMessage}` : pendingUserMessage;

                const chatForWI = coreChat
                    .map(x => {
                        const text = String(x?.mes ?? '');
                        if (world_info_include_names && x?.name) return `${x.name}: ${text}`;
                        return text;
                    })
                    .reverse();

                if (pendingUserMessage) {
                    const alreadyHasPending =
                        chatForWI.length > 0 && (
                            chatForWI[0] === pendingScanText ||
                            chatForWI[0] === pendingUserMessage ||
                            (world_info_include_names && chatForWI[0].endsWith(`: ${pendingUserMessage}`))
                        );

                    if (!alreadyHasPending) {
                        chatForWI.unshift(pendingScanText);
                    }
                }

                // 对齐 ST 真实发送时的“可用上下文长度”用于 WI budget 计算。
                // 注意：getContext().maxContext 只反映 max_context（全局滑条），而 OpenAI 聊天补全通常用 oai_settings.openai_max_context。
                // 不同 ST 版本/构建下 getMaxContextSize 可能不是可导出的符号，所以这里用多级回退。
                const resolveMaxContext = async () => {
                    try {
                        if (typeof window.getMaxContextSize === 'function') {
                            const value = Number(window.getMaxContextSize());
                            if (Number.isFinite(value) && value > 0) return value;
                        }
                    } catch {
                        // ignore
                    }

                    try {
                        const scriptMod = await import('/script.js');
                        if (typeof scriptMod.getMaxContextSize === 'function') {
                            const value = Number(scriptMod.getMaxContextSize());
                            if (Number.isFinite(value) && value > 0) return value;
                        }

                        // OpenAI chat completion path (most common mismatch source)
                        if (scriptMod.main_api === 'openai') {
                            const openaiMod = await import('/scripts/openai.js');
                            const openaiMax = Number(openaiMod?.oai_settings?.openai_max_context);
                            const openaiMaxTokens = Number(openaiMod?.oai_settings?.openai_max_tokens);
                            const value = openaiMax - openaiMaxTokens;
                            if (Number.isFinite(value) && value > 0) return value;
                        }
                    } catch {
                        // ignore
                    }

                    const fallback = Number(context.maxContext);
                    return (Number.isFinite(fallback) && fallback > 0) ? fallback : 4096;
                };

                const maxContext = await resolveMaxContext();
                // 这里必须使用“非 dryRun”的扫描路径，否则 ST 的 sticky/cooldown（timed effects）不会被计入，导致条目缺失。
                // 但为了避免影响 ST 自己随后的真实生成，我们在 finally 中完整还原 timedWorldInfo / Author's Note 等副作用。
                const activated = await checkWorldInfo(chatForWI, maxContext, false, globalScanData);
                if (!activated?.allActivatedEntries) return '';

                const allowed = new Set(bookNames);
                const rawEntries = Array.from(activated.allActivatedEntries || [])
                    .filter(entry => entry && allowed.has(entry.world));

                if (rawEntries.length === 0) return '';

                const getOrder = (entry) => {
                    const value = Number(entry?.order);
                    return Number.isFinite(value) ? value : 0;
                };

                const getUid = (entry) => {
                    const value = Number(entry?.uid);
                    return Number.isFinite(value) ? value : 0;
                };

                const toContent = (entry) => {
                    const text = String(entry?.content ?? '').trim();
                    return text.length ? text : '';
                };

                const sortByOrderThenUid = (a, b) =>
                    a.order - b.order ||
                    a.uid - b.uid;

                // ST 常用 position：0=before, 1=after, 4=atDepth（参见 ST 的 world_info_position 枚举）
                const before = [];
                const after = [];
                const others = [];
                /** @type {Map<string, { depth: number, role: string, items: Array<{order:number, uid:number, content:string}> }>} */
                const depthGroups = new Map();

                for (const entry of rawEntries) {
                    const content = toContent(entry);
                    if (!content) continue;

                    const item = { order: getOrder(entry), uid: getUid(entry), content };
                    const position = Number(entry?.position);

                    if (position === 0) {
                        before.push(item);
                        continue;
                    }
                    if (position === 1) {
                        after.push(item);
                        continue;
                    }
                    if (position === 4) {
                        const depth = Number.isFinite(Number(entry?.depth)) ? Number(entry.depth) : 0;
                        const role = String(entry?.role ?? 'system');
                        const key = `${depth}::${role}`;
                        if (!depthGroups.has(key)) {
                            depthGroups.set(key, { depth, role, items: [] });
                        }
                        depthGroups.get(key).items.push(item);
                        continue;
                    }

                    others.push(item);
                }

                before.sort(sortByOrderThenUid);
                after.sort(sortByOrderThenUid);
                others.sort(sortByOrderThenUid);

                const sortedDepthGroups = Array.from(depthGroups.values())
                    .map(group => {
                        group.items.sort(sortByOrderThenUid);
                        return group;
                    })
                    // 近似 ST 注入：depth 越大越“更早”插入到对话里；这里按 depth 从大到小展示
                    .sort((a, b) => b.depth - a.depth || a.role.localeCompare(b.role));

                const contents = [
                    ...before.map(x => x.content),
                    ...sortedDepthGroups.flatMap(group => group.items.map(x => x.content)),
                    ...after.map(x => x.content),
                    ...others.map(x => x.content),
                ].filter(Boolean);

                const combined = contents.join('\n\n---\n\n');
                console.debug('[qrf] Official WI scan result length:', combined.length);
                return combined;
            } catch (error) {
                console.warn('[剧情优化大师] 官方 World Info 扫描失败，将回退到旧逻辑:', error);
                return null;
            } finally {
                restore();
            }
        };

        const officialContent = await tryGetWorldbookContentViaOfficialWI();
        if (typeof officialContent === 'string') {
            const combined = [officialContent, scriptInjectContent].filter(Boolean).join('\n\n---\n\n');
            return applyWorldbookLimit(stripConfiguredWorldInfoContent(combined));
        }

        let allEntries = [];
        for (const bookName of bookNames) {
            if (bookName) {
                const entries = await safeLorebookEntries(bookName);
                if (entries?.length) {
                    entries.forEach(entry => allEntries.push({ ...entry, bookName }));
                }
            }
        }

        if (allEntries.length === 0) return scriptInjectFinal;

        // [功能更新] 应用反向选择逻辑：过滤掉那些在disabledWorldbookEntries中被记录的条目。
        const disabledEntriesMap = apiSettings.disabledWorldbookEntries || {};
        const userEnabledEntries = allEntries.filter(entry => {
            // 首先，条目本身必须在SillyTavern中是启用的
            if (!entry.enabled) return false;
            
            // 其次，它不能出现在我们的禁用列表中
            const isDisabled = disabledEntriesMap[entry.bookName]?.includes(entry.uid);
            return !isDisabled;
        });

        if (userEnabledEntries.length === 0) return scriptInjectFinal;
        
        // [修复] hook 阶段最新用户消息可能尚未写入 chat 历史：这里手动把 userMessage 纳入扫描文本
        const historyParts = Array.isArray(context.chat) ? context.chat.map(message => message?.mes).filter(Boolean) : [];
        if (userMessage) historyParts.push(userMessage);
        const chatHistory = historyParts.join('\n').toLowerCase();
        const getEntryKeywords = (entry) => [...new Set([...(entry.key || []), ...(entry.keys || [])])].map(k => k.toLowerCase());

        const blueLightEntries = userEnabledEntries.filter(entry => entry.type === 'constant');
        let pendingGreenLights = userEnabledEntries.filter(entry => entry.type !== 'constant');
        
        const triggeredEntries = new Set([...blueLightEntries]);

        while (true) {
            let hasChangedInThisPass = false;
            
            const recursionSourceContent = Array.from(triggeredEntries)
                .filter(e => !e.prevent_recursion)
                .map(e => e.content)
                .join('\n')
                .toLowerCase();
            const fullSearchText = `${chatHistory}\n${recursionSourceContent}`;

            const nextPendingGreenLights = [];
            
            for (const entry of pendingGreenLights) {
                const keywords = getEntryKeywords(entry);
                let isTriggered = keywords.length > 0 && keywords.some(keyword => 
                    entry.exclude_recursion ? chatHistory.includes(keyword) : fullSearchText.includes(keyword)
                );

                if (isTriggered) {
                    triggeredEntries.add(entry);
                    hasChangedInThisPass = true;
                } else {
                    nextPendingGreenLights.push(entry);
                }
            }
            
            if (!hasChangedInThisPass) break;
            
            pendingGreenLights = nextPendingGreenLights;
        }

        const finalContent = Array.from(triggeredEntries).map(entry => entry.content).filter(Boolean);
        if (finalContent.length === 0) return scriptInjectFinal;

        const combinedContent = stripConfiguredWorldInfoContent([finalContent.join('\n\n---\n\n'), scriptInjectContent].filter(Boolean).join('\n\n---\n\n'));
        
        return applyWorldbookLimit(combinedContent);

    } catch (error) {
        console.error(`[剧情优化大师] 处理世界书逻辑时出错:`, error);
        return '';
    }
}
