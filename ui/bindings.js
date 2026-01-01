// 剧情优化大师 - UI数据绑定模块
// 由Cline参照 '优化/' 插件的健壮性实践重构

import { extension_settings, getContext } from '/scripts/extensions.js';
import { characters, this_chid, getRequestHeaders, saveSettingsDebounced, saveSettings as saveSettingsImmediate } from '/script.js';
import { eventSource, event_types } from '/script.js';
import { extensionName, defaultSettings } from '../utils/settings.js';
import { fetchModels, testApiConnection } from '../core/api.js';

/**
 * 手动触发所有设置的保存。
 * 这对于在关闭面板等事件时确保数据被保存非常有用。
 */
export async function saveAllSettings() {
    const panel = $('#qrf_settings_panel');
    if (panel.length === 0) return;

    console.log(`[${extensionName}] 手动触发所有设置的保存...`);
    
    // 触发所有相关输入元素的change事件，以利用现有的保存逻辑
    panel.find('input[type="checkbox"], input[type="radio"], input[type="text"], input[type="password"], textarea, select').trigger('change.qrf');
    
    // 对于滑块，input事件可能更合适，但change也应在值改变后触发
    panel.find('input[type="range"]').trigger('change.qrf');
    
    // [BUG修复] 确保世界书条目也被保存，并等待保存完成
    await saveDisabledEntries();
    
    toastr.info('设置已自动保存。');
}


/**
 * 将下划线或连字符命名的字符串转换为驼峰命名。
 * e.g., 'qrf_api_url' -> 'qrfApiUrl'
 * @param {string} str - 输入字符串。
 * @returns {string} - 驼峰格式字符串。
 */
function toCamelCase(str) {
    return str.replace(/[-_]([a-z])/g, (g) => g[1].toUpperCase());
}

/**
 * 根据选择的API模式，更新URL输入框的可见性并自动填充URL。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 * @param {string} apiMode - 当前选择的API模式 ('backend', 'frontend', 或 'google')。
 */
function updateApiUrlVisibility(panel, apiMode) {
    const customApiSettings = panel.find('#qrf_custom_api_settings_block');
    const tavernProfileSettings = panel.find('#qrf_tavern_api_profile_block');
    const apiUrlInput = panel.find('#qrf_api_url');
    
    // Hide all blocks first
    customApiSettings.hide();
    tavernProfileSettings.hide();

    if (apiMode === 'tavern') {
        tavernProfileSettings.show();
    } else {
        customApiSettings.show();
        if (apiMode === 'google') {
            panel.find('#qrf_api_url_block').hide();
            const googleUrl = 'https://generativelanguage.googleapis.com';
            if (apiUrlInput.val() !== googleUrl) {
                apiUrlInput.val(googleUrl).trigger('change');
            }
        } else {
            panel.find('#qrf_api_url_block').show();
        }
    }
}

/**
 * 根据选择的世界书来源，显示或隐藏手动选择区域。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 * @param {string} source - 当前选择的来源 ('character', 'manual', or 'both')。
 */
function updateWorldbookSourceVisibility(panel, source) {
    const manualSelectionWrapper = panel.find('#qrf_worldbook_select_wrapper');
    const additionalSelectionWrapper = panel.find('#qrf_additional_worldbook_select_wrapper');
    
    if (source === 'manual') {
        manualSelectionWrapper.show();
        additionalSelectionWrapper.hide();
    } else if (source === 'both') {
        manualSelectionWrapper.hide();
        additionalSelectionWrapper.show();
    } else {
        manualSelectionWrapper.hide();
        additionalSelectionWrapper.hide();
    }
}

/**
 * 加载SillyTavern的API连接预设到下拉菜单。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
async function loadTavernApiProfiles(panel) {
    const select = panel.find('#qrf_tavern_api_profile_select');
    const apiSettings = getMergedApiSettings();
    const currentProfileId = apiSettings.tavernProfile;
    
    // 保存当前值，清空并添加默认选项
    const currentValue = select.val();
    select.empty().append(new Option('-- 请选择一个酒馆预设 --', ''));

    try {
        const tavernProfiles = getContext().extensionSettings?.connectionManager?.profiles || [];
        if (!tavernProfiles || tavernProfiles.length === 0) {
            select.append($('<option>', { value: '', text: '未找到酒馆预设', disabled: true }));
            return;
        }

        let foundCurrentProfile = false;
        tavernProfiles.forEach(profile => {
            if (profile.api && profile.preset) { // 确保是有效的API预设
                const option = $('<option>', {
                    value: profile.id,
                    text: profile.name || profile.id,
                    selected: profile.id === currentProfileId
                });
                select.append(option);
                if (profile.id === currentProfileId) {
                    foundCurrentProfile = true;
                }
            }
        });

        // 如果之前保存的ID无效了，给出提示
        if (currentProfileId && !foundCurrentProfile) {
            toastr.warning(`之前选择的酒馆预设 "${currentProfileId}" 已不存在，请重新选择。`);
            saveSetting('tavernProfile', '');
        } else if (foundCurrentProfile) {
             select.val(currentProfileId);
        }

    } catch (error) {
        console.error(`[${extensionName}] 加载酒馆API预设失败:`, error);
        toastr.error('无法加载酒馆API预设列表，请查看控制台。');
    }
}


/**
 * 根据选择的世界书来源，显示或隐藏手动选择区域。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 * @param {string} source - 当前选择的来源 ('character' or 'manual')。
 */
// ---- 新的、支持角色卡独立配置的设置保存/加载逻辑 ----

// 需要保存到角色卡的设置项列表
const characterSpecificSettings = [
    'disabledWorldbookEntries'
];

// [修复] worldbookSource 现在是全局设置，需要从角色卡中清除
const deprecatedCharacterSettings = [
    'worldbookSource'
];

/**
 * 保存单个设置项。
 * 根据设置项的键名，决定是保存到全局设置还是当前角色卡。
 * @param {string} key - 设置项的键（驼峰式）。
 * @param {*} value - 设置项的值。
 */
async function saveSetting(key, value) {
    if (characterSpecificSettings.includes(key)) {
        // --- 保存到角色卡 ---
        const character = characters[this_chid];
        if (!character) {
            // 在没有角色卡的情况下，静默失败，不保存角色特定设置
            console.warn(`[${extensionName}] 无法保存 ${key}：当前没有选中角色`);
            return;
        }

        if (!character.data.extensions) character.data.extensions = {};
        if (!character.data.extensions[extensionName]) character.data.extensions[extensionName] = {};
        if (!character.data.extensions[extensionName].apiSettings) character.data.extensions[extensionName].apiSettings = {};
        
        character.data.extensions[extensionName].apiSettings[key] = value;
        
        console.log(`[${extensionName}] 准备保存角色卡设置: ${key} ->`, value);
        console.log(`[${extensionName}] 角色卡路径: ${character.avatar}`);
        
        // 使用SillyTavern的API来异步保存角色数据
        try {
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar: character.avatar,
                    data: { extensions: { [extensionName]: character.data.extensions[extensionName] } }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API call failed with status: ${response.status}, body: ${errorText}`);
            }
            console.log(`[${extensionName}] ✅ 角色卡设置已成功保存到文件: ${key}`);
        } catch (error) {
            console.error(`[${extensionName}] ❌ 保存角色数据失败:`, error);
            toastr.error(`无法保存角色卡设置 (${key})，请检查控制台。`);
        }

    } else {
        // --- 保存到全局设置 (旧逻辑) ---
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        
        const apiSettingKeys = Object.keys(defaultSettings.apiSettings);
        if (apiSettingKeys.includes(key)) {
            if (!extension_settings[extensionName].apiSettings) {
                extension_settings[extensionName].apiSettings = {};
            }
            extension_settings[extensionName].apiSettings[key] = value;
        } else {
            extension_settings[extensionName][key] = value;
        }

        console.log(`[${extensionName}] 全局设置已更新: ${key} ->`, value);
        saveSettingsDebounced();

        // [最终修复] 在保存全局设置时，主动、同步地清除角色卡上的同名陈旧设置
        const character = characters[this_chid];
        if (character?.data?.extensions?.[extensionName]?.apiSettings?.[key] !== undefined) {
            delete character.data.extensions[extensionName].apiSettings[key];
            
            // 使用 await 强制等待保存操作完成，彻底消除竞争条件
            try {
                const response = await fetch('/api/characters/merge-attributes', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        avatar: character.avatar,
                        data: { extensions: { [extensionName]: character.data.extensions[extensionName] } }
                    })
                });

                if (response.ok) {
                    console.log(`[${extensionName}] 已成功从角色卡中同步清除陈旧设置: ${key}`);
                } else {
                    throw new Error(`API call failed with status: ${response.status}`);
                }
            } catch (error) {
                 console.error(`[${extensionName}] 同步清除角色卡陈旧设置失败:`, error);
            }
        }
    }
}


/**
 * 获取合并后的设置对象。
 * 以全局设置为基础，然后用当前角色卡的设置覆盖它。
 * @returns {object} - 合并后的apiSettings对象。
 */
function getMergedApiSettings() {
    const character = characters[this_chid];
    const globalSettings = extension_settings[extensionName]?.apiSettings || defaultSettings.apiSettings;
    const characterSettings = character?.data?.extensions?.[extensionName]?.apiSettings || {};
    
    // [修复] 过滤掉角色卡中已弃用的设置项，防止它们覆盖全局设置
    const filteredCharacterSettings = { ...characterSettings };
    deprecatedCharacterSettings.forEach(key => {
        delete filteredCharacterSettings[key];
    });
    
    return { ...globalSettings, ...filteredCharacterSettings };
}

/**
 * [新增] 清除当前角色卡上所有陈旧的、与提示词相关的设置。
 * 这是为了防止旧的角色卡数据覆盖新加载的全局预设。
 */
/**
 * [新增] 清除当前角色卡上所有陈旧的、本应是全局的设置。
 * 这是为了防止旧的角色卡数据覆盖新的全局设置。
 * @param {'prompts' | 'api'} type - 要清除的设置类型。
 */
async function clearCharacterStaleSettings(type) {
    const character = characters[this_chid];
    if (!character?.data?.extensions?.[extensionName]?.apiSettings) {
        return; // 没有角色或没有设置可清除。
    }

    const charApiSettings = character.data.extensions[extensionName].apiSettings;
    let keysToClear = [];
    let message = '';

    if (type === 'prompts') {
        keysToClear = ['mainPrompt', 'systemPrompt', 'finalSystemDirective', 'rateMain', 'ratePersonal', 'rateErotic', 'rateCuckold'];
        message = '陈旧提示词设置';
    } else if (type === 'api') {
        // 清除所有非角色特定的API设置
        const allApiKeys = Object.keys(defaultSettings.apiSettings);
        keysToClear = allApiKeys.filter(key => !characterSpecificSettings.includes(key));
        message = '陈旧API连接设置';
    }

    if (keysToClear.length === 0) return;

    let settingsCleared = false;
    keysToClear.forEach(key => {
        if (charApiSettings[key] !== undefined) {
            delete charApiSettings[key];
            settingsCleared = true;
        }
    });

    if (settingsCleared) {
        try {
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar: character.avatar,
                    data: { extensions: { [extensionName]: { apiSettings: charApiSettings } } }
                })
            });
            if (!response.ok) throw new Error(`API call failed with status: ${response.status}`);
            console.log(`[${extensionName}] 已成功清除当前角色卡的${message}。`);
        } catch (error) {
            console.error(`[${extensionName}] 清除角色${message}失败:`, error);
            toastr.error(`无法清除角色卡上的${message}。`);
        }
    }
}

/**
 * [修复] 清除当前角色卡上已弃用的设置项（如worldbookSource）
 * 这些设置现在应该是全局的，不应存储在角色卡上
 */
async function clearDeprecatedCharacterSettings() {
    const character = characters[this_chid];
    if (!character?.data?.extensions?.[extensionName]?.apiSettings) {
        return;
    }

    const charApiSettings = character.data.extensions[extensionName].apiSettings;
    let settingsCleared = false;

    deprecatedCharacterSettings.forEach(key => {
        if (charApiSettings[key] !== undefined) {
            console.log(`[${extensionName}] 清除角色卡上的陈旧设置: ${key} = ${charApiSettings[key]}`);
            delete charApiSettings[key];
            settingsCleared = true;
        }
    });

    if (settingsCleared) {
        try {
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar: character.avatar,
                    data: { extensions: { [extensionName]: { apiSettings: charApiSettings } } }
                })
            });
            if (!response.ok) throw new Error(`API call failed with status: ${response.status}`);
            console.log(`[${extensionName}] 已成功清除角色卡上的陈旧世界书来源设置。`);
        } catch (error) {
            console.error(`[${extensionName}] 清除角色陈旧设置失败:`, error);
        }
    }
}



// ---- 世界书逻辑 ----
async function loadWorldbooks(panel) {
    const container = panel.find('#qrf_worldbook_list_container');
    const apiSettings = getMergedApiSettings();
    const currentSelection = apiSettings.selectedWorldbooks || [];
    container.empty();

    try {
        const lorebooks = await window.TavernHelper.getLorebooks();
        if (!lorebooks || lorebooks.length === 0) {
            container.html('<p class="notes">未找到世界书</p>');
            return;
        }

        lorebooks.forEach((name, index) => {
            const itemId = `qrf-worldbook-${index}`;
            const isSelected = currentSelection.includes(name);
            const item = $(`
                <div class="qrf_worldbook_entry_item">
                    <input type="checkbox" id="${itemId}" data-worldbook="${name}" ${isSelected ? 'checked' : ''}>
                    <label for="${itemId}">${name}</label>
                </div>
            `);
            container.append(item);
        });
    } catch (error) {
        console.error(`[${extensionName}] 加载世界书失败:`, error);
        toastr.error('无法加载世界书列表，请查看控制台。');
    }
}

async function loadAdditionalWorldbooks(panel) {
    const container = panel.find('#qrf_additional_worldbook_list_container');
    const apiSettings = getMergedApiSettings();
    const currentSelection = apiSettings.additionalWorldbooks || [];
    container.empty();

    try {
        const lorebooks = await window.TavernHelper.getLorebooks();
        if (!lorebooks || lorebooks.length === 0) {
            container.html('<p class="notes">未找到世界书</p>');
            return;
        }

        lorebooks.forEach((name, index) => {
            const itemId = `qrf-additional-worldbook-${index}`;
            const isSelected = currentSelection.includes(name);
            const item = $(`
                <div class="qrf_worldbook_entry_item">
                    <input type="checkbox" id="${itemId}" data-worldbook="${name}" ${isSelected ? 'checked' : ''}>
                    <label for="${itemId}">${name}</label>
                </div>
            `);
            container.append(item);
        });
    } catch (error) {
        console.error(`[${extensionName}] 加载额外世界书失败:`, error);
        toastr.error('无法加载世界书列表，请查看控制台。');
    }
}

function saveSelectedWorldbooks() {
    const panel = $('#qrf_settings_panel');
    const selectedBooks = [];
    
    panel.find('#qrf_worldbook_list_container input[type="checkbox"]:checked').each(function() {
        selectedBooks.push($(this).data('worldbook'));
    });
    
    saveSetting('selectedWorldbooks', selectedBooks);
}

function saveAdditionalWorldbooks() {
    const panel = $('#qrf_settings_panel');
    const selectedBooks = [];
    
    panel.find('#qrf_additional_worldbook_list_container input[type="checkbox"]:checked').each(function() {
        selectedBooks.push($(this).data('worldbook'));
    });
    
    saveSetting('additionalWorldbooks', selectedBooks);
}

async function loadWorldbookEntries(panel) {
    const container = panel.find('#qrf_worldbook_entry_list_container');
    const countDisplay = panel.find('#qrf_worldbook_entry_count');
    container.html('<p>加载条目中...</p>');
    countDisplay.text('');

    const apiSettings = getMergedApiSettings(); // 使用合并后的设置
    const currentSource = apiSettings.worldbookSource || 'character';
    
    // [BUG修复] disabledWorldbookEntries是角色卡专属设置，需要直接从角色卡读取，不能从合并设置读取
    const character = characters[this_chid];
    const disabledEntries = character?.data?.extensions?.[extensionName]?.apiSettings?.disabledWorldbookEntries || {};
    
    console.log(`[${extensionName}] 加载世界书条目 - 当前模式: ${currentSource}, 禁用条目:`, disabledEntries);
    
    let bookNames = [];

    if (currentSource === 'manual') {
        bookNames = apiSettings.selectedWorldbooks || [];
    } else if (currentSource === 'both') {
        // 同时使用角色卡世界书和额外指定的世界书
        if (this_chid === -1 || !characters[this_chid]) {
            container.html('<p class="notes">未选择角色。</p>');
            countDisplay.text('');
            return;
        }
        try {
            const charLorebooks = await window.TavernHelper.getCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
            
            // 添加额外指定的世界书
            const additionalBooks = apiSettings.additionalWorldbooks || [];
            for (const bookName of additionalBooks) {
                if (bookName && !bookNames.includes(bookName)) {
                    bookNames.push(bookName);
                }
            }
        } catch (error) {
            console.error(`[${extensionName}] 获取角色世界书失败:`, error);
            toastr.error('获取角色世界书失败。');
            container.html('<p class="notes" style="color:red;">获取角色世界书失败。</p>');
            return;
        }
    } else {
        // 修复：在尝试获取角色世界书之前，先检查是否已加载角色
        if (this_chid === -1 || !characters[this_chid]) {
            container.html('<p class="notes">未选择角色。</p>');
            countDisplay.text('');
            return; // 没有角色，直接返回，不弹窗
        }
        try {
            const charLorebooks = await window.TavernHelper.getCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
        } catch (error) {
            // 只有在确实有角色但加载失败时才报错
            console.error(`[${extensionName}] 获取角色世界书失败:`, error);
            toastr.error('获取角色世界书失败。');
            container.html('<p class="notes" style="color:red;">获取角色世界书失败。</p>');
            return;
        }
    }

    const selectedBooks = bookNames;
    // disabledEntries 已在函数开头声明并从角色卡读取
    let totalEntries = 0;
    let visibleEntries = 0;

    if (selectedBooks.length === 0) {
        container.html('<p class="notes">请选择一个或多个世界书以查看其条目。</p>');
        return;
    }

    try {
        const allEntries = [];
        for (const bookName of selectedBooks) {
            const entries = await window.TavernHelper.getLorebookEntries(bookName);
            entries.forEach(entry => {
                allEntries.push({ ...entry, bookName });
            });
        }

        container.empty();
        totalEntries = allEntries.length;

        if (totalEntries === 0) {
            container.html('<p class="notes">所选世界书没有条目。</p>');
            countDisplay.text('0 条目.');
            return;
        }

        allEntries.sort((a, b) => (a.comment || '').localeCompare(b.comment || '')).forEach(entry => {
            // [核心优化] 如果条目在SillyTavern中是关闭的，则直接跳过，不在UI中显示
            if (!entry.enabled) return;

            const entryId = `qrf-entry-${entry.bookName.replace(/[^a-zA-Z0-9]/g, '-')}-${entry.uid}`;
            // [功能更新] 反向选择逻辑：默认全部勾选，只取消勾选那些被记录为“禁用”的条目。
            const isDisabled = disabledEntries[entry.bookName]?.includes(entry.uid);

            const item = $(`
                <div class="qrf_worldbook_entry_item">
                    <input type="checkbox" id="${entryId}" data-book="${entry.bookName}" data-uid="${entry.uid}" ${!isDisabled ? 'checked' : ''}>
                    <label for="${entryId}" title="世界书: ${entry.bookName}\nUID: ${entry.uid}">${entry.comment || '无标题条目'}</label>
                </div>
            `);
            container.append(item);
        });
        
        visibleEntries = container.children().length;
        countDisplay.text(`显示 ${visibleEntries} / ${totalEntries} 条目.`);

    } catch (error) {
        console.error(`[${extensionName}] 加载世界书条目失败:`, error);
        container.html('<p class="notes" style="color:red;">加载条目失败。</p>');
    }
}


async function saveDisabledEntries() {
    const panel = $('#qrf_settings_panel');
    
    // [BUG修复] 获取当前所有显示的世界书名称
    const currentVisibleBooks = new Set();
    panel.find('#qrf_worldbook_entry_list_container input[type="checkbox"]').each(function() {
        currentVisibleBooks.add($(this).data('book'));
    });
    
    // [BUG修复] 从角色卡读取现有的禁用列表
    const character = characters[this_chid];
    const existingDisabledEntries = character?.data?.extensions?.[extensionName]?.apiSettings?.disabledWorldbookEntries || {};
    
    // [核心修复] 首先，显式清空当前可见的所有世界书的条目（设为空数组）
    let disabledEntries = {};
    currentVisibleBooks.forEach(bookName => {
        disabledEntries[bookName] = [];
    });
    
    // [核心修复] 保留不在当前视图中的世界书的禁用状态
    Object.keys(existingDisabledEntries).forEach(bookName => {
        if (!currentVisibleBooks.has(bookName)) {
            disabledEntries[bookName] = existingDisabledEntries[bookName];
        }
    });

    // 然后，添加当前未勾选的条目
    panel.find('#qrf_worldbook_entry_list_container input[type="checkbox"]').each(function() {
        const bookName = $(this).data('book');
        const uid = parseInt($(this).data('uid'));

        // [功能更新] 只记录未勾选的条目
        if (!$(this).is(':checked')) {
            disabledEntries[bookName].push(uid);
        }
    });


    console.log(`[${extensionName}] 保存禁用的世界书条目:`, disabledEntries);
    console.log(`[${extensionName}] 当前可见的世界书:`, Array.from(currentVisibleBooks));
    await saveSetting('disabledWorldbookEntries', disabledEntries);
    console.log(`[${extensionName}] 禁用的世界书条目已保存到角色卡文件`);
}

/**
 * 加载并填充提示词预设到下拉菜单。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function loadPromptPresets(panel) {
    const presets = extension_settings[extensionName]?.promptPresets || [];
    const select = panel.find('#qrf_prompt_preset_select');

    const currentValue = select.val();
    select.empty().append(new Option('-- 选择一个预设 --', ''));

    presets.forEach(preset => {
        select.append(new Option(preset.name, preset.name));
    });

    // 仅恢复选择，不触发change或显示按钮，这些由其他逻辑处理
    if (currentValue && presets.some(p => p.name === currentValue)) {
        select.val(currentValue);
    }
}

/**
 * 交互式地保存一个新的或覆盖一个现有的提示词预设 (用于“另存为”功能)。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function saveAsNewPreset(panel) {
    const presetName = prompt("请输入新预设的名称：");
    if (!presetName) return;

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const existingPresetIndex = presets.findIndex(p => p.name === presetName);

    const newPresetData = {
        name: presetName,
        mainPrompt: panel.find('#qrf_main_prompt').val(),
        systemPrompt: panel.find('#qrf_system_prompt').val(),
        finalSystemDirective: panel.find('#qrf_final_system_directive').val(),
        rateMain: parseFloat(panel.find('#qrf_rate_main').val()),
        ratePersonal: parseFloat(panel.find('#qrf_rate_personal').val()),
        rateErotic: parseFloat(panel.find('#qrf_rate_erotic').val()),
        rateCuckold: parseFloat(panel.find('#qrf_rate_cuckold').val()),
        // [新功能] 导出时包含新增的设置
        excludeTags: panel.find('#qrf_exclude_tags').val(),
        extractTags: panel.find('#qrf_extract_tags').val(),
        minLength: parseInt(panel.find('#qrf_min_length').val(), 10),
        contextTurnCount: parseInt(panel.find('#qrf_context_turn_count').val(), 10),
        requiredKeywords: panel.find('#qrf_required_keywords').val(),
        maxRetries: parseInt(panel.find('#qrf_max_retries').val(), 10)
    };

    if (existingPresetIndex !== -1) {
        if (confirm(`名为 "${presetName}" 的预设已存在。是否要覆盖它？`)) {
            presets[existingPresetIndex] = newPresetData;
            toastr.success(`预设 "${presetName}" 已被覆盖。`);
        } else {
            toastr.info('保存操作已取消。');
            return;
        }
    } else {
        presets.push(newPresetData);
        toastr.success(`新预设 "${presetName}" 已保存。`);
    }
    saveSetting('promptPresets', presets);

    loadPromptPresets(panel);
    setTimeout(() => {
        panel.find('#qrf_prompt_preset_select').val(presetName).trigger('change');
    }, 0);
}


/**
 * 覆盖当前选中的提示词预设 (用于“保存”功能)。
 * 如果没有预设被选中，则行为与“另存为”相同。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function overwriteSelectedPreset(panel) {
    const select = panel.find('#qrf_prompt_preset_select');
    const selectedName = select.val();

    if (!selectedName) {
        // 如果没有选择预设，则“保存”应等同于“另存为”
        saveAsNewPreset(panel);
        return;
    }

    if (!confirm(`确定要用当前设置覆盖预设 "${selectedName}" 吗？`)) {
        return;
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const existingPresetIndex = presets.findIndex(p => p.name === selectedName);

    if (existingPresetIndex === -1) {
        toastr.error('找不到要覆盖的预设，它可能已被删除。');
        return;
    }
    
    const updatedPresetData = {
        name: selectedName,
        mainPrompt: panel.find('#qrf_main_prompt').val(),
        systemPrompt: panel.find('#qrf_system_prompt').val(),
        finalSystemDirective: panel.find('#qrf_final_system_directive').val(),
        rateMain: parseFloat(panel.find('#qrf_rate_main').val()),
        ratePersonal: parseFloat(panel.find('#qrf_rate_personal').val()),
        rateErotic: parseFloat(panel.find('#qrf_rate_erotic').val()),
        rateCuckold: parseFloat(panel.find('#qrf_rate_cuckold').val()),
        // [新功能] 覆盖时包含新增的设置
        excludeTags: panel.find('#qrf_exclude_tags').val(),
        extractTags: panel.find('#qrf_extract_tags').val(),
        minLength: parseInt(panel.find('#qrf_min_length').val(), 10),
        contextTurnCount: parseInt(panel.find('#qrf_context_turn_count').val(), 10),
        requiredKeywords: panel.find('#qrf_required_keywords').val(),
        maxRetries: parseInt(panel.find('#qrf_max_retries').val(), 10)
    };

    presets[existingPresetIndex] = updatedPresetData;
    saveSetting('promptPresets', presets);
    toastr.success(`预设 "${selectedName}" 已被成功覆盖。`);
}

/**
 * 删除当前选中的提示词预设。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function deleteSelectedPreset(panel) {
    const select = panel.find('#qrf_prompt_preset_select');
    const selectedName = select.val();

    if (!selectedName) {
        toastr.warning('没有选择任何预设。');
        return;
    }

    if (!confirm(`确定要删除预设 "${selectedName}" 吗？`)) {
        return;
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    // 修正: 使用 splice 直接修改原数组，而不是创建新数组，以确保UI能正确更新
    const indexToDelete = presets.findIndex(p => p.name === selectedName);

    if (indexToDelete > -1) {
        presets.splice(indexToDelete, 1);
        saveSetting('promptPresets', presets);
        toastr.success(`预设 "${selectedName}" 已被删除。`);
    } else {
        toastr.error('找不到要删除的预设，操作可能已过期。');
    }

    // 刷新UI
    loadPromptPresets(panel);
    // 触发change以更新删除按钮状态并清除lastUsed
    select.trigger('change');
}

/**
 * 导出当前选中的提示词预设到一个JSON文件。
 */
function exportPromptPresets() {
    const select = $('#qrf_prompt_preset_select');
    const selectedName = select.val();

    if (!selectedName) {
        toastr.info('请先从下拉菜单中选择一个要导出的预设。');
        return;
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const selectedPreset = presets.find(p => p.name === selectedName);

    if (!selectedPreset) {
        toastr.error('找不到选中的预设，请刷新页面后重试。');
        return;
    }

    // 为了兼容导入逻辑，我们始终导出一个包含单个对象的数组
    const dataToExport = [selectedPreset];
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    // 使用预设名作为文件名
    a.download = `qrf_preset_${selectedName.replace(/[^a-z0-9]/gi, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toastr.success(`预设 "${selectedName}" 已成功导出。`);
}

/**
 * 从一个JSON文件导入提示词预设。
 * @param {File} file - 用户选择的JSON文件。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function importPromptPresets(file, panel) {
    if (!file) return;

    function normalizeImportedPreset(preset) {
        if (!preset || typeof preset !== 'object') return null;
        if (typeof preset.name !== 'string' || preset.name.trim().length === 0) return null;

        const promptMap = {};
        if (Array.isArray(preset.prompts)) {
            for (const prompt of preset.prompts) {
                if (!prompt || typeof prompt !== 'object') continue;
                if (typeof prompt.id !== 'string') continue;
                if (typeof prompt.content !== 'string') continue;
                promptMap[prompt.id] = prompt.content;
            }
        }

        const extractTags = preset.extractTags ?? preset.contextExtractTags ?? preset.context_extract_tags ?? '';
        const excludeTags = preset.excludeTags ?? preset.contextExcludeTags ?? preset.context_exclude_tags ?? '';
        const maxRetries = preset.maxRetries ?? preset.loopSettings?.maxRetries ?? 3;

        return {
            name: preset.name,
            mainPrompt: promptMap.mainPrompt ?? preset.mainPrompt ?? '',
            systemPrompt: promptMap.systemPrompt ?? preset.systemPrompt ?? '',
            finalSystemDirective: promptMap.finalSystemDirective ?? preset.finalSystemDirective ?? '',
            rateMain: preset.rateMain ?? 1.0,
            ratePersonal: preset.ratePersonal ?? 1.0,
            rateErotic: preset.rateErotic ?? 1.0,
            rateCuckold: preset.rateCuckold ?? 1.0,
            excludeTags,
            extractTags,
            minLength: preset.minLength ?? defaultSettings.minLength,
            contextTurnCount: preset.contextTurnCount ?? defaultSettings.apiSettings.contextTurnCount,
            requiredKeywords: preset.requiredKeywords ?? '',
            maxRetries,
        };
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedPresets = JSON.parse(e.target.result);

            const presetList = Array.isArray(importedPresets)
                ? importedPresets
                : (importedPresets?.promptPresets && Array.isArray(importedPresets.promptPresets))
                    ? importedPresets.promptPresets
                    : null;

            if (!presetList) throw new Error('JSON文件格式不正确，根节点必须是数组（或包含 promptPresets 数组）。');

            let currentPresets = extension_settings[extensionName]?.promptPresets || [];
            let importedCount = 0;
            let overwrittenCount = 0;

            presetList.forEach(preset => {
                const presetData = normalizeImportedPreset(preset);
                if (!presetData) return;

                const existingIndex = currentPresets.findIndex(p => p.name === presetData.name);

                if (existingIndex !== -1) {
                    currentPresets[existingIndex] = presetData;
                    overwrittenCount++;
                } else {
                    currentPresets.push(presetData);
                    importedCount++;
                }
            });

            if (importedCount > 0 || overwrittenCount > 0) {
                const selectedPresetBeforeImport = panel.find('#qrf_prompt_preset_select').val();
                
                saveSetting('promptPresets', currentPresets);
                loadPromptPresets(panel);
                
                // 重新选中导入前选中的预设（如果它还存在的话），并强制触发change事件来刷新UI
                panel.find('#qrf_prompt_preset_select').val(selectedPresetBeforeImport);
                panel.find('#qrf_prompt_preset_select').trigger('change');

                let messages = [];
                if (importedCount > 0) messages.push(`成功导入 ${importedCount} 个新预设。`);
                if (overwrittenCount > 0) messages.push(`成功覆盖 ${overwrittenCount} 个同名预设。`);
                toastr.success(messages.join(' '));
            } else {
                toastr.warning('未找到可导入的有效预设。');
            }

        } catch (error) {
            console.error(`[${extensionName}] 导入预设失败:`, error);
            toastr.error(`导入失败: ${error.message}`, '错误');
        } finally {
            // 清空文件输入框的值，以便可以再次选择同一个文件
            panel.find('#qrf_preset_file_input').val('');
        }
    };
    reader.readAsText(file);
}

/**
 * 显示最新的分析数据
 * [架构优化] 与getPlotFromHistory()保持一致的查找策略：
 * 优先从user消息中查找（新格式），找不到则从assistant消息中查找（旧格式）
 */
function showLatestAnalysisData() {
    const context = getContext();
    
    // 检查是否有聊天记录
    if (!context || !context.chat || context.chat.length === 0) {
        toastr.warning('当前没有聊天记录。', '无数据');
        console.log(`[${extensionName}] 查看分析数据：无聊天记录`);
        return;
    }
    
    console.log(`[${extensionName}] 开始查找分析数据，聊天记录总数: ${context.chat.length}`);
    
    // 策略1: 优先从user消息中查找最新的plot数据（新格式）
    let latestPlot = null;
    let messageIndex = -1;
    
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const message = context.chat[i];
        if (message.is_user && message.qrf_plot) {
            latestPlot = message.qrf_plot;
            messageIndex = i;
            console.log(`[${extensionName}] 找到分析数据于用户消息 #${i} (新格式)`);
            break;
        }
    }
    
    // 策略2: 如果没找到，从assistant消息中查找（旧格式，后向兼容）
    if (!latestPlot) {
        for (let i = context.chat.length - 1; i >= 0; i--) {
            const message = context.chat[i];
            if (!message.is_user && message.qrf_plot) {
                latestPlot = message.qrf_plot;
                messageIndex = i;
                console.log(`[${extensionName}] 找到分析数据于助手消息 #${i} (旧格式)`);
                break;
            }
        }
    }
    
    if (!latestPlot) {
        console.warn(`[${extensionName}] 未找到任何qrf_plot数据`);
        
        // 提供更详细的调试信息
        const debugInfo = context.chat.slice(-3).map((msg, idx) => {
            const actualIndex = context.chat.length - 3 + idx;
            return `消息#${actualIndex}: is_user=${msg.is_user}, 属性=${Object.keys(msg).join(', ')}`;
        }).join('\n');
        
        console.log(`[${extensionName}] 最近3条消息的属性:\n${debugInfo}`);
        toastr.info('未找到分析数据。请先进行剧情规划后再试。\n\n提示：请检查浏览器控制台以获取详细信息。', '无数据', {timeOut: 5000});
        return;
    }
    
    // 创建模态对话框显示数据
    const modal = $(`
    <div id="qrf_analysis_modal" class="qrf_modal" style="position: fixed !important; z-index: 10001 !important; left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; overflow: auto !important;">
        <div class="qrf_modal_content">
            <div class="qrf_modal_header">
                <h3><i class="fa-solid fa-file-lines"></i> 最新分析数据 (消息 #${messageIndex + 1})</h3>
                <button id="qrf_modal_close" class="menu_button" title="关闭">
                    <i class="fa-solid fa-times"></i>
                </button>
            </div>
            <div class="qrf_modal_body">
                <div class="qrf_modal_actions">
                    <button id="qrf_edit_analysis" class="menu_button" title="编辑分析数据">
                        <i class="fa-solid fa-edit"></i> 编辑
                    </button>
                    <button id="qrf_save_analysis" class="menu_button" title="保存修改" style="display: none;">
                        <i class="fa-solid fa-save"></i> 保存
                    </button>
                    <button id="qrf_cancel_edit" class="menu_button" title="取消编辑" style="display: none;">
                        <i class="fa-solid fa-times"></i> 取消
                    </button>
                    <button id="qrf_copy_analysis" class="menu_button" title="复制到剪贴板">
                        <i class="fa-solid fa-copy"></i> 复制
                    </button>
                    <small class="notes" style="margin-left: 10px;">字符数: <span id="qrf_char_count">${latestPlot.length}</span></small>
                </div>
                <textarea id="qrf_analysis_content" readonly style="width: 100%; min-height: 500px; max-height: 600px; padding: 10px; background: var(--SmartThemeBlurTintColor); border-radius: 5px; border: 1px solid; font-family: 'Consolas', 'Monaco', 'Courier New', monospace; font-size: 0.9em; line-height: 1.6; resize: vertical; white-space: pre-wrap; word-wrap: break-word;"></textarea>
            </div>
        </div>
    </div>
`);

// 移除已存在的模态框
$('#qrf_analysis_modal').remove();

// 添加到页面
$('body').append(modal);

// 使用.text()设置内容以防止HTML渲染
$('#qrf_analysis_content').text(latestPlot);

    
    // 绑定关闭事件
    $('#qrf_modal_close, #qrf_analysis_modal').on('click', function(e) {
        if (e.target === this) {
            $('#qrf_analysis_modal').remove();
        }
    });
    
    // 绑定编辑按钮事件
    $('#qrf_edit_analysis').on('click', function() {
        const textarea = $('#qrf_analysis_content');
        textarea.prop('readonly', false).focus();
        $(this).hide();
        $('#qrf_copy_analysis').hide();
        $('#qrf_save_analysis, #qrf_cancel_edit').show();
        textarea.css('border-color', '#2196F3');
    });
    
    // 绑定取消编辑事件
    $('#qrf_cancel_edit').on('click', function() {
        const textarea = $('#qrf_analysis_content');
        textarea.prop('readonly', true).text(latestPlot);
        $('#qrf_char_count').text(latestPlot.length);
        $(this).hide();
        $('#qrf_save_analysis').hide();
        $('#qrf_edit_analysis, #qrf_copy_analysis').show();
        textarea.css('border-color', '');
    });
    
    // 绑定保存按钮事件
    $('#qrf_save_analysis').on('click', async function() {
        const newContent = $('#qrf_analysis_content').val();
        const context = getContext();
        
        if (messageIndex >= 0 && messageIndex < context.chat.length) {
            // 更新聊天记录中的数据
            context.chat[messageIndex].qrf_plot = newContent;
            latestPlot = newContent;
            
            // 触发聊天保存
            try {
                const { saveChatConditional } = await import('/script.js');
                await saveChatConditional();
                toastr.success('分析数据已保存！', '保存成功');
                console.log(`[${extensionName}] 分析数据已更新并保存到消息 #${messageIndex}`);
                
                // 退出编辑模式
                const textarea = $('#qrf_analysis_content');
                textarea.prop('readonly', true);
                $('#qrf_char_count').text(newContent.length);
                $('#qrf_save_analysis, #qrf_cancel_edit').hide();
                $('#qrf_edit_analysis, #qrf_copy_analysis').show();
                textarea.css('border-color', '');
            } catch (error) {
                console.error(`[${extensionName}] 保存分析数据失败:`, error);
                toastr.error('保存失败，请查看控制台。', '保存失败');
            }
        }
    });
    
    // 绑定复制事件
    $('#qrf_copy_analysis').on('click', function() {
        const content = $('#qrf_analysis_content').val();
        navigator.clipboard.writeText(content).then(() => {
            toastr.success('已复制到剪贴板！', '复制成功');
        }).catch(err => {
            console.error('复制失败:', err);
            toastr.error('复制失败，请手动选择并复制。', '复制失败');
        });
    });
    
    // 实时更新字符数
    $('#qrf_analysis_content').on('input', function() {
        $('#qrf_char_count').text($(this).val().length);
    });
    
    console.log(`[${extensionName}] 显示最新分析数据 (来自消息 #${messageIndex + 1})`);
}

/**
 * 加载 jailbreak 提示词到UI
 * @param {JQuery} panel - 设置面板的jQuery对象
 */
function loadJailbreakPrompts(panel) {
    const container = panel.find('#qrf_jailbreak_prompts_container');
    const jailbreakPrompts = extension_settings[extensionName]?.jailbreakPrompts || [];
    
    container.empty();
    
    jailbreakPrompts.forEach((prompt, index) => {
        const item = createJailbreakPromptItem(prompt, index);
        container.append(item);
    });
}

/**
 * 创建单个 jailbreak 提示词 UI 项
 * @param {object} prompt - 提示词对象 {role, content}
 * @param {number} index - 索引
 * @returns {JQuery} 提示词项元素
 */
function createJailbreakPromptItem(prompt, index) {
    const isPlaceholder = prompt.content === '$CORE_PROMPTS';
    
    const item = $(`
        <div class="qrf_jailbreak_prompt_item" data-index="${index}">
            <div class="qrf_jb_drag_handle" title="拖动排序">
                <i class="fa-solid fa-grip-vertical"></i>
            </div>
            <div class="qrf_jb_content">
                ${!isPlaceholder ? `
                <select class="qrf_jb_role_select">
                    <option value="system" ${prompt.role === 'system' ? 'selected' : ''}>System</option>
                    <option value="user" ${prompt.role === 'user' ? 'selected' : ''}>User</option>
                    <option value="assistant" ${prompt.role === 'assistant' ? 'selected' : ''}>Assistant</option>
                </select>
                ` : '<strong style="color: #2196F3;">$CORE_PROMPTS 占位符</strong>'}
                <textarea class="qrf_jb_textarea" placeholder="${isPlaceholder ? '核心提示词将在此位置插入' : '输入提示词内容...'}" ${isPlaceholder ? 'readonly' : ''}>${prompt.content || ''}</textarea>
            </div>
            <div class="qrf_jb_actions">
                <button class="menu_button qrf_jb_move_up" title="上移" ${index === 0 ? 'disabled' : ''}>
                    <i class="fa-solid fa-arrow-up"></i>
                </button>
                <button class="menu_button qrf_jb_move_down" title="下移">
                    <i class="fa-solid fa-arrow-down"></i>
                </button>
                <button class="menu_button qrf_jb_delete" title="删除">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
    `);
    
    return item;
}

/**
 * 保存 jailbreak 提示词
 * @param {JQuery} panel - 设置面板的jQuery对象
 */
function saveJailbreakPrompts(panel) {
    const container = panel.find('#qrf_jailbreak_prompts_container');
    const prompts = [];
    
    container.find('.qrf_jailbreak_prompt_item').each(function() {
        const item = $(this);
        const content = item.find('.qrf_jb_textarea').val();
        
        if (content === '$CORE_PROMPTS') {
            prompts.push({ content: '$CORE_PROMPTS' });
        } else {
            const role = item.find('.qrf_jb_role_select').val() || 'system';
            prompts.push({ role, content });
        }
    });
    
    saveSetting('jailbreakPrompts', prompts);
}

/**
 * 加载设置到UI界面。
 * @param {JQuery} panel - 设置面板的jQuery对象。
 */
function loadSettings(panel) {
    // 全局设置只用于非角色绑定的部分
    const globalSettings = extension_settings[extensionName] || defaultSettings;
    // API设置从合并后的来源获取
    const apiSettings = getMergedApiSettings();

    // 加载总开关 (全局)
    panel.find('#qrf_enabled').prop('checked', globalSettings.enabled);
    panel.find('#qrf_min_length').val(globalSettings.minLength ?? 500);

    // 加载API和模型设置 (大部分是全局，但世界书相关是角色卡)
    panel.find(`input[name="qrf_api_mode"][value="${apiSettings.apiMode}"]`).prop('checked', true);
    panel.find('#qrf_tavern_api_profile_select').val(apiSettings.tavernProfile); // 加载酒馆预设选择
    panel.find(`input[name="qrf_worldbook_source"][value="${apiSettings.worldbookSource || 'character'}"]`).prop('checked', true);
    panel.find('#qrf_worldbook_enabled').prop('checked', apiSettings.worldbookEnabled);
    panel.find('#qrf_api_url').val(apiSettings.apiUrl);
    panel.find('#qrf_api_key').val(apiSettings.apiKey);
    
    const modelInput = panel.find('#qrf_model');
    const modelSelect = panel.find('#qrf_model_select');
    
    modelInput.val(apiSettings.model);
    modelSelect.empty();
    if (apiSettings.model) {
        modelSelect.append(new Option(apiSettings.model, apiSettings.model, true, true));
    } else {
        modelSelect.append(new Option('<-请先获取模型', '', true, true));
    }

    panel.find('#qrf_max_tokens').val(apiSettings.maxTokens);
    panel.find('#qrf_temperature').val(apiSettings.temperature);
    panel.find('#qrf_top_p').val(apiSettings.topP);
    panel.find('#qrf_presence_penalty').val(apiSettings.presencePenalty);
    panel.find('#qrf_frequency_penalty').val(apiSettings.frequencyPenalty);
    panel.find('#qrf_context_turn_count').val(apiSettings.contextTurnCount);
    panel.find('#qrf_worldbook_char_limit').val(apiSettings.worldbookCharLimit);

    // [新增] 加载关键词和重试次数设置
    panel.find('#qrf_required_keywords').val(apiSettings.requiredKeywords || '');
    panel.find('#qrf_max_retries').val(apiSettings.maxRetries || 3);

    // 加载标签排除和摘取设置
    panel.find('#qrf_exclude_tags').val(apiSettings.excludeTags || '');
    panel.find('#qrf_extract_tags').val(apiSettings.extractTags || '');

    // 加载匹配替换速率
    panel.find('#qrf_rate_main').val(apiSettings.rateMain);
    panel.find('#qrf_rate_personal').val(apiSettings.ratePersonal);
    panel.find('#qrf_rate_erotic').val(apiSettings.rateErotic);
    panel.find('#qrf_rate_cuckold').val(apiSettings.rateCuckold);

    // 加载提示词
    panel.find('#qrf_main_prompt').val(apiSettings.mainPrompt);
    panel.find('#qrf_system_prompt').val(apiSettings.systemPrompt);
    panel.find('#qrf_final_system_directive').val(apiSettings.finalSystemDirective);

    updateApiUrlVisibility(panel, apiSettings.apiMode);
    updateWorldbookSourceVisibility(panel, apiSettings.worldbookSource || 'character');
    
    // 加载提示词预-设
    loadPromptPresets(panel);

    // 自动选择上次使用的预设 (全局)
    const lastUsedPresetName = globalSettings.lastUsedPresetName;
    if (lastUsedPresetName && (globalSettings.promptPresets || []).some(p => p.name === lastUsedPresetName)) {
        // 使用setTimeout确保下拉列表已完全填充
        setTimeout(() => {
            // 传递一个额外参数来标记这是自动触发的，以避免显示通知
            panel.find('#qrf_prompt_preset_select').val(lastUsedPresetName).trigger('change', { isAutomatic: true });
        }, 0);
    }
    
    // 加载世界书和条目 (使用角色卡设置)
    loadWorldbooks(panel).then(() => {
        loadAdditionalWorldbooks(panel).then(() => {
            loadWorldbookEntries(panel);
        });
    });
    
    // 加载酒馆API预设
    loadTavernApiProfiles(panel);
    
    // 加载 jailbreak 提示词
    loadJailbreakPrompts(panel);
}

/**
 * 为设置面板绑定所有事件。
 */
export function initializeBindings() {
    const panel = $('#qrf_settings_panel');
    if (panel.length === 0 || panel.data('events-bound')) {
        return;
    }

    let lastFocusedPromptTextarea = null;
    
    loadSettings(panel);

    // 监听角色切换事件，刷新UI
    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log(`[${extensionName}] 检测到角色/聊天切换，正在刷新设置UI...`);
        // [修复] 切换角色时，清除角色卡上的陈旧世界书来源设置
        clearDeprecatedCharacterSettings();
        loadSettings(panel);
    });

    // [功能更新 & 修复] 监听插件核心功能触发事件，刷新世界书
    eventSource.on('qrf-plugin-triggered', () => {
        // 重新获取panel引用以确保稳健性
        const currentPanel = $('#qrf_settings_panel');
        // 只要面板存在于DOM中就刷新，不再检查可见性，确保数据在需要时总是最新的。
        if (currentPanel.length > 0) {
            console.log(`[${extensionName}] 插件核心功能已触发，正在刷新世界书条目...`);
            // 直接调用 loadWorldbookEntries，它会处理所有加载逻辑
            loadWorldbookEntries(currentPanel);
        }
    });

    // --- 事件绑定区域 (智能保存) ---

    // 优化1: 创建一个统一的保存处理器，以避免代码重复
    const handleSettingChange = function(element) {
        const el = $(element);
        let key;
        
        if (element.name === 'qrf_worldbook_source') {
            key = 'worldbookSource';
        } else {
            key = toCamelCase((element.name || element.id).replace('qrf_', ''));
        }
        
        let value = element.type === 'checkbox' ? element.checked : el.val();

        if (key === 'selectedWorldbooks' && !Array.isArray(value)) {
            value = el.val() || [];
        }
        
        const floatKeys = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'rateMain', 'ratePersonal', 'rateErotic', 'rateCuckold'];
        if (floatKeys.includes(key) && value !== '') {
            value = parseFloat(value);
        } else if (element.type === 'range' || element.type === 'number') {
            if (value !== '') value = parseInt(value, 10);
        }
        
        if (value !== '' || element.type === 'checkbox') {
             saveSetting(key, value);
        }

        if (element.name === 'qrf_api_mode') {
            updateApiUrlVisibility(panel, value);
            // [核心修复] 切换API模式时，清除所有旧的、非角色特定的API设置
            clearCharacterStaleSettings('api');
        }
        if (element.name === 'qrf_worldbook_source') {
            updateWorldbookSourceVisibility(panel, value);
            loadWorldbookEntries(panel);
        }
    };

    // 优化2: 统一所有输入控件的事件绑定，实现更简洁、更一致的实时保存
    const allInputSelectors = [
        'input[type="checkbox"]', 'input[type="radio"]', 'select:not(#qrf_model_select)',
        'input[type="text"]', 'input[type="password"]', 'textarea',
        'input[type="range"]', 'input[type="number"]'
    ].join(', ');

    // 使用 'input' 和 'change' 事件确保覆盖所有交互场景：
    // - 'input' 实时捕捉打字、拖动等操作。
    // - 'change' 捕捉点击选择、粘贴、自动填充等操作。
    panel.on('input.qrf change.qrf', allInputSelectors, function() {
        handleSettingChange(this);
    });

    // 特殊处理模型选择下拉框
    panel.on('change.qrf', '#qrf_model_select', function() {
        const selectedModel = $(this).val();
        if (selectedModel) {
            // 手动触发模型输入框的change，会由上面的监听器捕获并保存
            panel.find('#qrf_model').val(selectedModel).trigger('change');
        }
    });

    // ---- 提示词占位符模板 ----

    panel.on('focusin.qrf', '#qrf_main_prompt, #qrf_system_prompt, #qrf_final_system_directive', function() {
        lastFocusedPromptTextarea = this;
    });

    const insertTextAtCursor = (textarea, textToInsert) => {
        if (!textarea || typeof textarea.value !== 'string') return;

        const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length;
        const end = typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : textarea.value.length;

        const before = textarea.value.slice(0, start);
        const after = textarea.value.slice(end);
        textarea.value = `${before}${textToInsert}${after}`;

        const newCursorPos = start + textToInsert.length;
        if (typeof textarea.setSelectionRange === 'function') {
            textarea.setSelectionRange(newCursorPos, newCursorPos);
        }

        textarea.focus();
        $(textarea).trigger('input').trigger('change');
    };

    panel.on('click.qrf', '[data-qrf-insert-placeholder]', function() {
        const placeholder = $(this).attr('data-qrf-insert-placeholder');
        if (!placeholder) return;

        const fallback = panel.find('#qrf_system_prompt')[0] || panel.find('#qrf_main_prompt')[0];
        const targetTextarea = lastFocusedPromptTextarea || fallback;
        if (!targetTextarea) {
            toastr.warning('未找到可插入的提示词输入框。');
            return;
        }

        insertTextAtCursor(targetTextarea, placeholder);
        toastr.success(`已插入 ${placeholder}`);
    });

    // --- 功能按钮事件 ---

    panel.find('#qrf_fetch_models').on('click', async function () {
        const button = $(this);
        // 修正: 从UI实时获取apiMode，以进行正确的逻辑判断
        const apiMode = panel.find('input[name="qrf_api_mode"]:checked').val();

        if (apiMode === 'tavern') {
            toastr.info('在“使用酒馆连接预设”模式下，模型已在预设中定义，无需单独获取。');
            return;
        }

        button.prop('disabled', true).find('i').addClass('fa-spin');
        
        // 修正: 确保传递给fetchModels的设置是最新的
        const apiSettings = getMergedApiSettings();
        const currentApiSettings = {
            ...apiSettings,
            apiUrl: panel.find('#qrf_api_url').val(),
            apiKey: panel.find('#qrf_api_key').val(),
            model: panel.find('#qrf_model').val(),
            apiMode: apiMode // 传递实时获取的apiMode
        };

        const models = await fetchModels(currentApiSettings);
        const modelSelect = panel.find('#qrf_model_select');
        modelSelect.empty().append(new Option('请选择一个模型', ''));
        
        if (models && models.length > 0) {
            models.forEach(model => modelSelect.append(new Option(model.id || model.model, model.id || model.model)));
            if (currentApiSettings.model && modelSelect.find(`option[value="${currentApiSettings.model}"]`).length > 0) {
                modelSelect.val(currentApiSettings.model);
            }
        } else {
             toastr.info('未能获取到模型列表，您仍然可以手动输入模型名称。');
        }
        
        button.prop('disabled', false).find('i').removeClass('fa-spin');
    });

    panel.find('#qrf_test_api').on('click', async function () {
        const button = $(this);
        button.prop('disabled', true).find('i').addClass('fa-spin');
        const apiSettings = getMergedApiSettings();
        // 修正: 直接从UI读取最新的API URL, Key和模型, 避免因设置未保存导致测试失败的问题
        const currentApiSettings = {
            ...apiSettings,
            apiUrl: panel.find('#qrf_api_url').val(),
            apiKey: panel.find('#qrf_api_key').val(),
            model: panel.find('#qrf_model').val(),
            apiMode: panel.find('input[name="qrf_api_mode"]:checked').val(), // 实时获取当前API模式
            // 确保测试时也传递 tavernProfile
            tavernProfile: panel.find('#qrf_tavern_api_profile_select').val()
        };
        await testApiConnection(currentApiSettings);
        button.prop('disabled', false).find('i').removeClass('fa-spin');
    });

    // 绑定酒馆API预设刷新按钮
    panel.on('click.qrf', '#qrf_refresh_tavern_api_profiles', () => {
        loadTavernApiProfiles(panel);
    });

    // 绑定酒馆API预设选择事件
    panel.on('change.qrf', '#qrf_tavern_api_profile_select', function() {
        const value = $(this).val();
        saveSetting('tavernProfile', value);
    });

    // --- 提示词预设功能 ---

    panel.find('#qrf_import_prompt_presets').on('click', () => panel.find('#qrf_preset_file_input').click());
    panel.find('#qrf_export_prompt_presets').on('click', () => exportPromptPresets());
    panel.find('#qrf_save_prompt_preset').on('click', () => overwriteSelectedPreset(panel));
    panel.find('#qrf_save_as_new_prompt_preset').on('click', () => saveAsNewPreset(panel));
    panel.find('#qrf_delete_prompt_preset').on('click', () => deleteSelectedPreset(panel));

    panel.on('change.qrf', '#qrf_preset_file_input', function(e) {
        importPromptPresets(e.target.files[0], panel);
    });

    panel.on('change.qrf', '#qrf_prompt_preset_select', async function(event, data) {
        const selectedName = $(this).val();
        const deleteBtn = panel.find('#qrf_delete_prompt_preset');
        const isAutomatic = data && data.isAutomatic; // 检查是否是自动触发
        
        // 保存当前选择
        await saveSetting('lastUsedPresetName', selectedName);

        if (!selectedName) {
            deleteBtn.hide();
            // 如果取消选择，也清空上次选择的记录
            saveSetting('lastUsedPresetName', '');
            return;
        }

        const presets = extension_settings[extensionName]?.promptPresets || [];
        const selectedPreset = presets.find(p => p.name === selectedName);

        if (selectedPreset) {
            // [增强] 当选择预设时，直接、原子性地更新UI和设置
            const presetData = {
                mainPrompt: selectedPreset.mainPrompt,
                systemPrompt: selectedPreset.systemPrompt,
                finalSystemDirective: selectedPreset.finalSystemDirective,
                rateMain: selectedPreset.rateMain ?? 1.0,
                ratePersonal: selectedPreset.ratePersonal ?? 1.0,
                rateErotic: selectedPreset.rateErotic ?? 1.0,
                rateCuckold: selectedPreset.rateCuckold ?? 1.0,
                 // [新功能] 加载预设时应用新设置
                excludeTags: selectedPreset.excludeTags || '',
                extractTags: selectedPreset.extractTags || '',
                minLength: selectedPreset.minLength ?? defaultSettings.minLength,
                contextTurnCount: selectedPreset.contextTurnCount ?? defaultSettings.apiSettings.contextTurnCount,
                requiredKeywords: selectedPreset.requiredKeywords || '',
                maxRetries: selectedPreset.maxRetries ?? 3
            };

            // 1. 更新UI界面
            panel.find('#qrf_main_prompt').val(presetData.mainPrompt);
            panel.find('#qrf_system_prompt').val(presetData.systemPrompt);
            panel.find('#qrf_final_system_directive').val(presetData.finalSystemDirective);
            panel.find('#qrf_rate_main').val(presetData.rateMain);
            panel.find('#qrf_rate_personal').val(presetData.ratePersonal);
            panel.find('#qrf_rate_erotic').val(presetData.rateErotic);
            panel.find('#qrf_rate_cuckold').val(presetData.rateCuckold);
            panel.find('#qrf_exclude_tags').val(presetData.excludeTags);
            panel.find('#qrf_extract_tags').val(presetData.extractTags);
            panel.find('#qrf_min_length').val(presetData.minLength);
            panel.find('#qrf_context_turn_count').val(presetData.contextTurnCount);
            panel.find('#qrf_required_keywords').val(presetData.requiredKeywords);
            panel.find('#qrf_max_retries').val(presetData.maxRetries);

            // 2. 直接、同步地覆盖apiSettings中的内容
            // saveSetting现在是异步的，我们需要等待它完成
            for (const [key, value] of Object.entries(presetData)) {
                await saveSetting(key, value);
            }

            // [核心修复] 清除角色卡上可能存在的、会覆盖全局预设的陈旧设置
            await clearCharacterStaleSettings('prompts');
            
            // [最终修复] 强制立即将更新后的全局设置写入磁盘，彻底消除异步竞争条件
            saveSettingsImmediate();

            // 只有在非自动触发时才显示通知
            if (!isAutomatic) {
                toastr.success(`已加载预设 "${selectedName}"。`);
            }
            deleteBtn.show();
        } else {
            deleteBtn.hide();
        }
    });

    // --- 重置按钮事件 ---

    panel.find('#qrf_reset_main_prompt').on('click', function() {
        panel.find('#qrf_main_prompt').val(defaultSettings.apiSettings.mainPrompt).trigger('change');
        toastr.success('主提示词已重置为默认值。');
    });

    panel.find('#qrf_reset_system_prompt').on('click', function() {
        panel.find('#qrf_system_prompt').val(defaultSettings.apiSettings.systemPrompt).trigger('change');
        toastr.success('拦截任务指令已重置为默认值。');
    });

    panel.find('#qrf_reset_final_system_directive').on('click', function() {
        panel.find('#qrf_final_system_directive').val(defaultSettings.apiSettings.finalSystemDirective).trigger('change');
        toastr.success('最终注入指令已重置为默认值。');
    });

    panel.data('events-bound', true);
    console.log(`[${extensionName}] UI事件已成功绑定，自动保存已激活。`);

    // ---- 世界书事件绑定 ----
    panel.on('click.qrf', '#qrf_refresh_worldbooks', () => {
        loadWorldbooks(panel).then(() => {
            loadWorldbookEntries(panel);
        });
    });

    panel.on('change.qrf', '#qrf_worldbook_list_container input[type="checkbox"]', function() {
        saveSelectedWorldbooks();
        loadWorldbookEntries(panel);
    });

    // 额外世界书选择器和刷新按钮
    panel.on('click.qrf', '#qrf_refresh_additional_worldbooks', () => {
        loadAdditionalWorldbooks(panel).then(() => {
            loadWorldbookEntries(panel);
        });
    });

    panel.on('change.qrf', '#qrf_additional_worldbook_list_container input[type="checkbox"]', function() {
        saveAdditionalWorldbooks();
        loadWorldbookEntries(panel);
    });

    panel.on('change.qrf', '#qrf_worldbook_entry_list_container input[type="checkbox"]', () => {
        saveDisabledEntries();
    });

    panel.on('click.qrf', '#qrf_worldbook_entry_select_all', () => {
        panel.find('#qrf_worldbook_entry_list_container input[type="checkbox"]').prop('checked', true);
        saveDisabledEntries();
    });

    panel.on('click.qrf', '#qrf_worldbook_entry_deselect_all', () => {
        panel.find('#qrf_worldbook_entry_list_container input[type="checkbox"]').prop('checked', false);
        saveDisabledEntries();
    });

    // ---- 查看最新分析数据按钮 ----
    // 使用document级别委托确保按钮始终可点击
    $(document).off('click.qrf_view_analysis').on('click.qrf_view_analysis', '#qrf_view_latest_analysis', function(e) {
        e.preventDefault();
        e.stopPropagation();
        console.log(`[${extensionName}] 查看最新分析按钮被点击`);
        showLatestAnalysisData();
    });

    // ---- Jailbreak 提示词管理器事件绑定 ----
    
    // 添加新提示词
    panel.on('click.qrf', '#qrf_add_jailbreak_prompt', function() {
        console.log('[QRF] 添加提示词按钮被点击');
        try {
            const container = panel.find('#qrf_jailbreak_prompts_container');
            console.log('[QRF] Container found:', container.length);
            const newPrompt = { role: 'system', content: '' };
            const index = container.find('.qrf_jailbreak_prompt_item').length;
            console.log('[QRF] Creating item at index:', index);
            const item = createJailbreakPromptItem(newPrompt, index);
            container.append(item);
            saveJailbreakPrompts(panel);
            toastr.success('已添加新提示词');
        } catch (error) {
            console.error('[QRF] Error adding jailbreak prompt:', error);
            toastr.error('添加提示词失败: ' + error.message);
        }
    });
    
    // 添加核心提示词占位符
    panel.on('click.qrf', '#qrf_add_core_placeholder', function() {
        const container = panel.find('#qrf_jailbreak_prompts_container');
        const hasPlaceholder = container.find('.qrf_jb_textarea').filter(function() {
            return $(this).val() === '$CORE_PROMPTS';
        }).length > 0;
        
        if (hasPlaceholder) {
            toastr.warning('$CORE_PROMPTS 占位符已存在');
            return;
        }
        
        const newPrompt = { content: '$CORE_PROMPTS' };
        const index = container.find('.qrf_jailbreak_prompt_item').length;
        const item = createJailbreakPromptItem(newPrompt, index);
        container.append(item);
        saveJailbreakPrompts(panel);
        toastr.success('已插入核心提示词占位符');
    });
    
    // 删除提示词
    panel.on('click.qrf', '.qrf_jb_delete', function() {
        const item = $(this).closest('.qrf_jailbreak_prompt_item');
        if (confirm('确定要删除这个提示词吗？')) {
            item.remove();
            saveJailbreakPrompts(panel);
            loadJailbreakPrompts(panel);
            toastr.success('已删除提示词');
        }
    });
    
    // 上移提示词
    panel.on('click.qrf', '.qrf_jb_move_up', function() {
        const item = $(this).closest('.qrf_jailbreak_prompt_item');
        const prev = item.prev('.qrf_jailbreak_prompt_item');
        if (prev.length) {
            item.insertBefore(prev);
            saveJailbreakPrompts(panel);
            loadJailbreakPrompts(panel);
        }
    });
    
    // 下移提示词
    panel.on('click.qrf', '.qrf_jb_move_down', function() {
        const item = $(this).closest('.qrf_jailbreak_prompt_item');
        const next = item.next('.qrf_jailbreak_prompt_item');
        if (next.length) {
            item.insertAfter(next);
            saveJailbreakPrompts(panel);
            loadJailbreakPrompts(panel);
        }
    });
    
    // 角色选择变化
    panel.on('change.qrf', '.qrf_jb_role_select', function() {
        saveJailbreakPrompts(panel);
    });
    
    // 内容变化
    panel.on('input.qrf change.qrf', '.qrf_jb_textarea', function() {
        clearTimeout($(this).data('saveTimeout'));
        const timeout = setTimeout(() => {
            saveJailbreakPrompts(panel);
        }, 500);
        $(this).data('saveTimeout', timeout);
    });
}
