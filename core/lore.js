// 快速响应部队 - 世界书处理模块
// 由Cline移植并重构，核心功能来自Amily2号插件

import { safeCharLorebooks, safeLorebookEntries } from './tavernhelper-compatibility.js';
import { checkWorldInfo, loadWorldInfo, worldInfoCache, world_info_include_names, world_info } from '/scripts/world-info.js';
import { characters, chat_metadata, getCharacterCardFields, this_chid } from '/script.js';
import { power_user } from '/scripts/power-user.js';
import { getCharaFilename } from '/scripts/utils.js';

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

    try {
        let bookNames = [];
        
        if (apiSettings.worldbookSource === 'manual') {
            // 仅使用手动选择的世界书
            bookNames = normalizeWorldNames(apiSettings.selectedWorldbooks);
            if (bookNames.length === 0) return '';
        } else if (apiSettings.worldbookSource === 'both') {
            // 同时使用角色卡世界书和额外指定的世界书
            const charLorebooks = await safeCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
            
            // 添加额外指定的世界书
            bookNames.push(...normalizeWorldNames(apiSettings.additionalWorldbooks));
            bookNames = normalizeWorldNames(bookNames);
            
            if (bookNames.length === 0) return '';
        } else {
            // 默认：仅使用角色卡绑定的世界书
            const charLorebooks = await safeCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
            bookNames = normalizeWorldNames(bookNames);
            if (bookNames.length === 0) return '';
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

                const coreChat = Array.isArray(context.chat) ? context.chat.filter(x => !x?.is_system) : [];
                const pendingUserMessage = String(userMessage || '').trim();
                const userDisplayName = context?.name1 || 'You';
                const pendingScanText = world_info_include_names ? `${userDisplayName}: ${pendingUserMessage}` : pendingUserMessage;

                const chatForWI = coreChat
                    .map(x => {
                        const text = String(x?.mes ?? '').trim();
                        if (!text) return '';
                        if (world_info_include_names && x?.name) return `${x.name}: ${text}`;
                        return text;
                    })
                    .filter(Boolean)
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

                const maxContext = Number(context.maxContext) || 4096;
                const activated = await checkWorldInfo(chatForWI, maxContext, true, globalScanData);
                if (!activated?.allActivatedEntries) return '';

                const allowed = new Set(bookNames);
                const contents = [];

                for (const entry of activated.allActivatedEntries) {
                    if (!entry || !allowed.has(entry.world)) continue;
                    const content = String(entry.content ?? '').trim();
                    if (content) contents.push(content);
                }

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
            const stripped = stripConfiguredWorldInfoContent(officialContent);
            const limit = apiSettings.worldbookCharLimit !== undefined ? apiSettings.worldbookCharLimit : 60000;
            if (limit > 0 && stripped.length > limit) {
                console.log(`[剧情优化大师] 世界书内容 (${stripped.length} chars) 超出限制 (${limit} chars)，将被截断。`);
                return stripped.substring(0, limit);
            }
            return stripped;
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

        if (allEntries.length === 0) return '';

        // [功能更新] 应用反向选择逻辑：过滤掉那些在disabledWorldbookEntries中被记录的条目。
        const disabledEntriesMap = apiSettings.disabledWorldbookEntries || {};
        const userEnabledEntries = allEntries.filter(entry => {
            // 首先，条目本身必须在SillyTavern中是启用的
            if (!entry.enabled) return false;
            
            // 其次，它不能出现在我们的禁用列表中
            const isDisabled = disabledEntriesMap[entry.bookName]?.includes(entry.uid);
            return !isDisabled;
        });

        if (userEnabledEntries.length === 0) return '';
        
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
        if (finalContent.length === 0) return '';

        const combinedContent = stripConfiguredWorldInfoContent(finalContent.join('\n\n---\n\n'));
        
        // [修复] 支持设为0来禁用字符限制
        const limit = apiSettings.worldbookCharLimit !== undefined 
            ? apiSettings.worldbookCharLimit 
            : 60000;
        
        if (limit > 0 && combinedContent.length > limit) {
            console.log(`[剧情优化大师] 世界书内容 (${combinedContent.length} chars) 超出限制 (${limit} chars)，将被截断。`);
            return combinedContent.substring(0, limit);
        }

        return combinedContent;

    } catch (error) {
        console.error(`[剧情优化大师] 处理世界书逻辑时出错:`, error);
        return '';
    }
}
