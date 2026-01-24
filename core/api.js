// core/api.js
// 核心API模块，根据用户反馈重构为三种独立的API模式
import { getContext } from '/scripts/extensions.js';
import { getRequestHeaders } from '/script.js';
import { buildGoogleRequest, parseGoogleResponse } from '../utils/googleAdapter.js';
import { getPromptPlaceholderReplacements } from '../utils/promptPlaceholders.js';

const extensionName = 'quick-response-force';

/**
 * 流式请求处理函数，支持25秒chunk超时检测
 * @param {string} url - 请求URL
 * @param {object} options - fetch选项
 * @param {boolean} isGoogleApi - 是否为Google API
 * @returns {Promise<string>} 完整的响应内容
 */
async function fetchWithStreamAndTimeout(url, options, isGoogleApi = false) {
    const CHUNK_TIMEOUT = 25000; // 25秒chunk超时
    let lastChunkTime = Date.now();
    let timeoutId;
    let accumulatedContent = '';
    
    // 启用流式传输
    const streamOptions = {
        ...options,
        body: options.body ? JSON.parse(options.body) : undefined
    };
    
    if (streamOptions.body) {
        // OpenAI兼容接口需要在payload里声明stream=true；Google接口通过不同endpoint控制是否流式
        if (!isGoogleApi) {
            streamOptions.body.stream = true;
        }
        streamOptions.body = JSON.stringify(streamOptions.body);
    }
    
    console.log(`[${extensionName}] 发起流式请求至: ${url}`);
    
    const response = await fetch(url, streamOptions);
    
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    try {
        let buffer = '';
        
        const checkTimeout = () => {
            const now = Date.now();
            if (now - lastChunkTime > CHUNK_TIMEOUT) {
                reader.cancel();
                throw new Error(`流式传输超时：${CHUNK_TIMEOUT/1000}秒内未收到新数据块`);
            }
        };
        
        // 启动超时检测
        timeoutId = setInterval(checkTimeout, 1000);
        
        while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
                console.log(`[${extensionName}] 流式传输完成`);
                break;
            }
            
            // 更新最后接收chunk的时间
            lastChunkTime = Date.now();
            
            // 解码chunk
            buffer += decoder.decode(value, { stream: true });
            
            // 处理SSE格式的数据
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // 保留不完整的行
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    
                    if (data === '[DONE]') {
                        continue;
                    }
                    
                    try {
                        const parsed = JSON.parse(data);
                        
                        if (isGoogleApi) {
                            // Google API格式
                            const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (content) {
                                accumulatedContent += content;
                            }
                        } else {
                            // OpenAI格式
                            const content = parsed.choices?.[0]?.delta?.content;
                            if (content) {
                                accumulatedContent += content;
                            }
                        }
                    } catch (e) {
                        // 忽略无法解析的行
                        console.debug(`[${extensionName}] 跳过无法解析的数据行:`, data);
                    }
                }
            }
        }
        
        if (!accumulatedContent) {
            throw new Error('流式传输未返回任何内容');
        }
        
        console.log(`[${extensionName}] 累积内容长度: ${accumulatedContent.length} 字符`);
        return accumulatedContent.trim();
        
    } finally {
        if (timeoutId) {
            clearInterval(timeoutId);
        }
        reader.releaseLock();
    }
}

/**
 * 为Promise添加超时控制
 * @param {Promise} promise - 要包装的Promise
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @param {string} errorMessage - 超时错误消息
 * @returns {Promise}
 */
function withTimeout(promise, timeoutMs, errorMessage = '请求超时') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
        )
    ]);
}

/**
 * 非流式fetch JSON（带超时、错误信息补全）
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 * @param {string} timeoutMessage
 * @returns {Promise<any>}
 */
async function fetchJsonWithTimeout(url, options, timeoutMs = 60000, timeoutMessage = '请求超时') {
    const fetchPromise = (async () => {
        const response = await fetch(url, options);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP error! status: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return await response.json();
        }

        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    })();

    return withTimeout(fetchPromise, timeoutMs, timeoutMessage);
}

// 导出流式处理函数供其他模块使用
export { fetchWithStreamAndTimeout };

/**
 * 统一处理和规范化API响应数据。
 * @param {*} responseData - 从API收到的原始响应数据
 * @returns {object} 规范化后的数据对象
 */
function normalizeApiResponse(responseData) {
    let data = responseData;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch (e) {
            console.error(`[${extensionName}] API响应JSON解析失败:`, e);
            return { error: { message: 'Invalid JSON response' } };
        }
    }
    if (data && typeof data.data === 'object' && data.data !== null && !Array.isArray(data.data)) {
        if (Object.hasOwn(data.data, 'data')) {
            data = data.data;
        }
    }
    if (data && data.choices && data.choices[0]) {
        return { content: data.choices[0].message?.content?.trim() };
    }
    if (data && data.content) {
        return { content: data.content.trim() };
    }
    if (data && data.data) { // for /v1/models
        return { data: data.data };
    }
    if (data && data.error) {
        return { error: data.error };
    }
    return data;
}

/**
 * 通过SillyTavern后端代理发送聊天请求（带超时控制）
 * @param {object} apiSettings - API设置
 * @param {Array} messages - 发送给API的消息数组
 * @returns {Promise<object|null>}
 */
async function callApiViaBackend(apiSettings, messages) {
    const request = {
        messages,
        model: apiSettings.model,
        max_tokens: apiSettings.maxTokens,
        temperature: apiSettings.temperature,
        top_p: apiSettings.topP,
        presence_penalty: apiSettings.presencePenalty,
        frequency_penalty: apiSettings.frequencyPenalty,
        stream: false,
        chat_completion_source: 'custom',
        custom_url: apiSettings.apiUrl,
        api_key: apiSettings.apiKey,
    };

    console.log(`[${extensionName}] 准备通过SillyTavern后端代理发送请求（带超时控制）`);

    try {
        const ajaxPromise = $.ajax({
            url: '/api/backends/chat-completions/generate',
            type: 'POST',
            contentType: 'application/json',
            headers: { 'Authorization': `Bearer ${apiSettings.apiKey}` },
            data: JSON.stringify(request),
        });
        
        // 添加60秒总超时（后端代理模式允许更长时间）
        const result = await withTimeout(
            ajaxPromise,
            60000,
            '后端代理请求超时（60秒）'
        );
        
        return normalizeApiResponse(result);
    } catch (error) {
        console.error(`[${extensionName}] 通过SillyTavern代理调用API时出错:`, error);
        
        if (error.message.includes('超时')) {
            toastr.error(`后端代理API请求超时: ${error.message}`, 'API超时');
        } else {
            toastr.error('API请求失败 (后端代理)，请检查控制台日志。', 'API错误');
        }
        return null;
    }
}


/**
 * 主API调用入口，根据设置选择不同的模式
 */
export async function callInterceptionApi(userMessage, contextMessages, apiSettings, worldbookContent, tableDataContent, globalSettings) {
    if (!apiSettings.apiUrl) {
        console.error(`[${extensionName}] API URL 未配置。`);
        return null;
    }

    // [新功能] 获取关键词验证配置
    const requiredKeywords = apiSettings.requiredKeywords
        ? apiSettings.requiredKeywords.split(',').map(kw => kw.trim()).filter(kw => kw.length > 0)
        : [];
    const maxRetries = apiSettings.maxRetries || 3;
    const useStreaming = apiSettings.useStreaming !== false;

    /**
     * [新功能] 验证响应是否包含所有必需的关键词
     * @param {string} content - API返回的内容
     * @returns {boolean} - 是否包含所有关键词
     */
    const validateKeywords = (content) => {
        if (requiredKeywords.length === 0) return true;

        console.log(`[${extensionName}] === 开始关键词验证 ===`);
        console.log(`[${extensionName}] 需要验证的关键词数量: ${requiredKeywords.length}`);
        console.log(`[${extensionName}] 关键词列表:`, requiredKeywords);
        console.log(`[${extensionName}] 内容总长度: ${content.length} 字符`);
        console.log(`[${extensionName}] 内容开头（前500字符）:`, content.substring(0, 500));
        console.log(`[${extensionName}] 内容结尾（后500字符）:`, content.substring(Math.max(0, content.length - 500)));

        for (const keyword of requiredKeywords) {
            const found = content.includes(keyword);
            console.log(`[${extensionName}] 检查关键词 "${keyword}" (长度: ${keyword.length}): ${found ? '✓ 找到' : '✗ 未找到'}`);
            
            if (!found) {
                // 尝试不区分大小写查找以帮助诊断
                const regex = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                const caseInsensitiveFound = regex.test(content);
                if (caseInsensitiveFound) {
                    console.warn(`[${extensionName}] ⚠️ 发现大小写不匹配的版本！`);
                }
                
                console.warn(`[${extensionName}] 回复缺少必需关键词: "${keyword}"`);
                console.log(`[${extensionName}] === 关键词验证失败 ===`);
                return false;
            }
        }
        
        console.log(`[${extensionName}] ✓ 所有关键词验证通过`);
        console.log(`[${extensionName}] === 关键词验证结束 ===`);
        return true;
    };

    /**
     * [新功能] 核心API调用函数（可重试）
     * @returns {Promise<string|null>}
     */
    const makeApiCall = async () => {
        const fullHistory = Array.isArray(contextMessages) ? [...contextMessages] : [];
        if (userMessage) {
            fullHistory.push({ role: 'user', content: userMessage });
        }

        const ucReplacements = getPromptPlaceholderReplacements(getContext());

        const sanitizeHtml = (htmlString) => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = htmlString;
            return tempDiv.textContent || tempDiv.innerText || '';
        };

        const formattedHistory = fullHistory.map(msg => `${msg.role}："${sanitizeHtml(msg.content)}"`).join(' \n ');
        const formattedHistoryInjection = formattedHistory
            ? `以下是前文的用户记录和故事发展，给你用作参考：\n ${formattedHistory}`
            : '';

        const hasUnescapedHistoryPlaceholder = (text) => {
            if (typeof text !== 'string') return false;
            return /(?<!\\)\$7/.test(text);
        };

        const usesHistoryPlaceholder =
            hasUnescapedHistoryPlaceholder(apiSettings.mainPrompt) ||
            hasUnescapedHistoryPlaceholder(apiSettings.systemPrompt);

        const replacePlaceholders = (text) => {
            if (typeof text !== 'string') return '';

            // 替换 $1 为世界书内容（世界书未启用时会移除该占位符）
            const worldbookReplacement = (apiSettings.worldbookEnabled && worldbookContent)
                ? `\n<worldbook_context>\n${worldbookContent}\n</worldbook_context>\n`
                : '';
            text = text.replace(/(?<!\\)\$1/g, worldbookReplacement);

            // 替换 $5 为“总体大纲”表内容（含表头）
            const tableDataReplacement = tableDataContent
                ? `\n<table_data_context>\n${tableDataContent}\n</table_data_context>\n`
                : '';
            text = text.replace(/(?<!\\)\$5/g, tableDataReplacement);

            // 替换 $7 为本次实际读取的前文上下文（AI上下文 + 本次用户输入，格式化后注入）
            text = text.replace(/(?<!\\)\$7/g, formattedHistoryInjection);

            // 替换 $U 为用户设定描述（persona_description）
            text = text.replace(/(?<!\\)\$U/g, ucReplacements.$U);

            // 替换 $C 为角色描述（char_description）
            text = text.replace(/(?<!\\)\$C/g, ucReplacements.$C);

            return text;
        };

        // 构建核心提示词消息数组
        const corePromptMessages = [];

        if (apiSettings.mainPrompt) {
            const content = replacePlaceholders(apiSettings.mainPrompt);
            if (content.trim()) {
                corePromptMessages.push({ role: 'system', content });
            }
        }

        // 兼容旧行为：若未使用 $7，则仍以独立 system message 注入前文上下文
        if (formattedHistoryInjection && !usesHistoryPlaceholder) {
            corePromptMessages.push({ role: 'system', content: formattedHistoryInjection });
        }

        if (apiSettings.systemPrompt) {
            const content = replacePlaceholders(apiSettings.systemPrompt);
            if (content.trim()) {
                corePromptMessages.push({ role: 'user', content });
            }
        }

        // 处理 jailbreak 提示词（支持单条开关，默认启用）
        const jailbreakPrompts = (globalSettings?.jailbreakPrompts || []).filter(p => p?.enabled !== false);
        const promptMode = globalSettings?.promptMode || 'classic';
        const messages = [];

        if (promptMode === 'jailbreak') {
            for (const jbPrompt of jailbreakPrompts) {
                if (jbPrompt.content === '$CORE_PROMPTS') continue;
                const content = replacePlaceholders(jbPrompt.content || '');
                if (content.trim()) {
                    messages.push({
                        role: jbPrompt.role || 'system',
                        content
                    });
                }
            }
        } else {
            let corePromptsInserted = false;

            if (jailbreakPrompts.length > 0) {
                for (const jbPrompt of jailbreakPrompts) {
                    if (jbPrompt.content === '$CORE_PROMPTS') {
                        messages.push(...corePromptMessages);
                        corePromptsInserted = true;
                    } else {
                        const content = replacePlaceholders(jbPrompt.content || '');
                        if (content.trim()) {
                            messages.push({
                                role: jbPrompt.role || 'system',
                                content
                            });
                        }
                    }
                }

                if (!corePromptsInserted) {
                    messages.push(...corePromptMessages);
                }
            } else {
            messages.push(...corePromptMessages);
            }
        }

        if (messages.length === 0) {
            console.error(`[${extensionName}] 消息数组为空，无法发送API请求`);
            toastr.error('提示词配置为空或全部被过滤，请检查提示词设置。', '配置错误');
            return null;
        }

        let result;
        // [新增] 酒馆连接预设模式（带超时控制）
        if (apiSettings.apiMode === 'tavern') {
            const profileId = apiSettings.tavernProfile;
            if (!profileId) {
                toastr.error('未选择酒馆连接预设。', '配置错误');
                return null;
            }

            let originalProfile = '';
            let responsePromise;
            try {
                // 方案：发送前切换，发送后立即切换回来
                originalProfile = await window.TavernHelper.triggerSlash('/profile');

                const context = getContext();
                const targetProfile = context.extensionSettings?.connectionManager?.profiles.find(p => p.id === profileId);

                if (!targetProfile) {
                    throw new Error(`无法找到ID为 "${profileId}" 的连接预设。`);
                }
                if (!targetProfile.api) {
                    throw new Error(`预设 "${targetProfile.name || targetProfile.id}" 没有配置API。`);
                }
                if (!targetProfile.preset) {
                    throw new Error(`预设 "${targetProfile.name || targetProfile.id}" 没有选择预设。`);
                }

                const targetProfileName = targetProfile.name;
                const currentProfile = await window.TavernHelper.triggerSlash('/profile');

                if (currentProfile !== targetProfileName) {
                    const escapedProfileName = targetProfileName.replace(/"/g, '\\"');
                    await window.TavernHelper.triggerSlash(`/profile await=true "${escapedProfileName}"`);
                }

                console.log(`[${extensionName}] 通过酒馆连接预设 "${targetProfile.name || targetProfile.id}" 发送请求（带超时控制）...`);

                // 发起请求并添加60秒超时
                const requestPromise = context.ConnectionManagerRequestService.sendRequest(
                    targetProfile.id,
                    messages
                );
                
                responsePromise = withTimeout(
                    requestPromise,
                    60000,
                    '酒馆连接请求超时（60秒）'
                );

            } catch (error) {
                console.error(`[${extensionName}] 通过酒馆连接预设调用API时出错:`, error);
                
                if (error.message.includes('超时')) {
                    toastr.error(`酒馆连接API请求超时: ${error.message}`, 'API超时');
                } else {
                    toastr.error(`API请求失败 (酒馆预设): ${error.message}`, 'API错误');
                }
                responsePromise = Promise.resolve(null);
            } finally {
                // 无论请求成功或失败，都立即尝试恢复原始预设
                const currentProfileAfterCall = await window.TavernHelper.triggerSlash('/profile');
                if (originalProfile && originalProfile !== currentProfileAfterCall) {
                    const escapedOriginalProfile = originalProfile.replace(/"/g, '\\"');
                    await window.TavernHelper.triggerSlash(`/profile await=true "${escapedOriginalProfile}"`);
                    console.log(`[${extensionName}] 已恢复原酒馆连接预设: "${originalProfile}"`);
                }
            }

            // 在恢复预设之后，再等待API响应
            result = await responsePromise;
        }
        else if (apiSettings.apiMode === 'perfect') {
            const profileId = apiSettings.tavernProfile;
            if (!profileId) {
                toastr.error('未选择酒馆连接预设。', '配置错误');
                return null;
            }
            const context = getContext();
            console.log(`[${extensionName}] 通过完美模式发送请求（带超时控制）...`);
            
            try {
                const requestPromise = context.ConnectionManagerRequestService.sendRequest(
                    profileId,
                    messages,
                    apiSettings.maxTokens,
                );
                
                // 添加60秒超时
                result = await withTimeout(
                    requestPromise,
                    60000,
                    '完美模式请求超时（60秒）'
                );
            } catch (error) {
                console.error(`[${extensionName}] 完美模式调用失败:`, error);
                
                if (error.message.includes('超时')) {
                    toastr.error(`完美模式API请求超时: ${error.message}`, 'API超时');
                } else {
                    toastr.error(`完美模式API请求失败: ${error.message}`, 'API错误');
                }
                result = null;
            }
        }
        else if (apiSettings.apiMode === 'backend') {
            result = await callApiViaBackend(apiSettings, messages);
        }
        // 前端直连模式 (包括OpenAI和Google)
        else {
            const { apiUrl, apiKey, model } = apiSettings;
            let finalApiUrl;
            let body;
            let headers = { 'Content-Type': 'application/json' };
            const isGoogleMode = apiSettings.apiMode === 'google';

            if (isGoogleMode) {
                const apiVersion = 'v1beta';
                const baseUrl = apiUrl.replace(/\/$/, '');
                finalApiUrl = useStreaming
                    ? `${baseUrl}/${apiVersion}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
                    : `${baseUrl}/${apiVersion}/models/${model}:generateContent?key=${apiKey}`;
                body = JSON.stringify(buildGoogleRequest(messages, apiSettings));
            } else { // 'frontend' mode
                headers['Authorization'] = `Bearer ${apiKey}`;
                finalApiUrl = apiUrl.replace(/\/$/, '');
                if (!finalApiUrl.endsWith('/chat/completions')) {
                    finalApiUrl += '/chat/completions';
                }
                body = JSON.stringify({
                    messages,
                    model,
                    max_tokens: apiSettings.maxTokens,
                    temperature: apiSettings.temperature,
                    top_p: apiSettings.topP,
                    presence_penalty: apiSettings.presencePenalty,
                    frequency_penalty: apiSettings.frequencyPenalty,
                    stream: useStreaming,
                });
            }

            console.log(`[${extensionName}] 准备通过前端直连发送${useStreaming ? '流式' : '非流式'}请求至 ${finalApiUrl}`);

            try {
                if (useStreaming) {
                    const content = await fetchWithStreamAndTimeout(finalApiUrl, { method: 'POST', headers, body }, isGoogleMode);
                    result = { content };
                } else {
                    const json = await fetchJsonWithTimeout(
                        finalApiUrl,
                        { method: 'POST', headers, body },
                        60000,
                        '前端直连请求超时（60秒）'
                    );

                    result = isGoogleMode
                        ? normalizeApiResponse(parseGoogleResponse(json))
                        : normalizeApiResponse(json);
                }
            } catch (error) {
                console.error(`[${extensionName}] 通过前端直连调用API时出错:`, error);
                
                // 检查是否为超时错误
                if (error.message.includes('超时')) {
                    toastr.error(`${useStreaming ? '流式' : '非流式'}请求超时: ${error.message}`, 'API超时');
                } else {
                    toastr.error('前端直连API请求失败，请检查CORS设置及控制台日志。', 'API错误');
                }
                result = null;
            }
        }

        if (result && result.content) {
            return result.content;
        }

        return null;
    };

    // [新功能] 实现重试逻辑
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[${extensionName}] API调用尝试 ${attempt}/${maxRetries}...`);

        const content = await makeApiCall();

        if (!content) {
            console.warn(`[${extensionName}] 第 ${attempt} 次尝试：API未返回有效内容`);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000)); // 等待1秒后重试
                continue;
            }
            break;
        }

        // [新功能] 验证关键词
        if (!validateKeywords(content)) {
            console.warn(`[${extensionName}] 第 ${attempt} 次尝试：回复缺少必需关键词`);
            if (attempt < maxRetries) {
                toastr.warning(`回复缺少必需关键词，正在重试 (${attempt}/${maxRetries})...`, extensionName);
                await new Promise(resolve => setTimeout(resolve, 1000)); // 等待1秒后重试
                continue;
            }
            // 最后一次尝试仍然失败
            toastr.error(`重试 ${maxRetries} 次后，AI回复仍缺少必需关键词。`, 'API错误');
            return null;
        }

        // 成功返回
        if (attempt > 1) {
            toastr.success(`第 ${attempt} 次尝试成功！`, extensionName);
        }
        return content;
    }

    // 所有尝试都失败
    console.error(`[${extensionName}] API调用在 ${maxRetries} 次尝试后失败`);
    toastr.error(`API调用失败，已重试 ${maxRetries} 次。`, 'API错误');
    return null;
}

/**
 * 获取模型列表
 * @param {object} apiSettings
 * @returns {Promise<Array|null>}
 */
export async function fetchModels(apiSettings) {
    const { apiUrl, apiKey, apiMode } = apiSettings;

    if (apiMode === 'tavern') {
        toastr.info('在“使用酒馆连接预设”模式下，模型已在预设中定义，无需单独获取。', '提示');
        return [];
    }

    if (!apiUrl) {
        toastr.error('API URL 未配置，无法获取模型列表。', '配置错误');
        return null;
    }

    try {
        let rawResponse;
        if (apiMode === 'backend') {
            console.log(`[${extensionName}] 通过后端代理获取模型列表`);
            rawResponse = await $.ajax({
                url: '/api/backends/chat-completions/status',
                type: 'POST',
                contentType: 'application/json',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                data: JSON.stringify({
                    chat_completion_source: 'custom',
                    custom_url: apiUrl,
                    api_key: apiKey,
                }),
            });
        } else { // 'frontend' or 'google'
            let modelsUrl;
            let headers = {};
            let responseTransformer = (json) => json.data || [];

            if (apiMode === 'google') {
                const apiVersion = 'v1beta';
                modelsUrl = `${apiUrl.replace(/\/$/, '')}/${apiVersion}/models?key=${apiKey}`;
                responseTransformer = (json) => json.models
                    ?.filter(model => model.supportedGenerationMethods?.includes('generateContent'))
                    ?.map(model => ({ id: model.name.replace('models/', '') })) || [];
            } else { // 'frontend'
                headers['Authorization'] = `Bearer ${apiKey}`;
                modelsUrl = apiUrl.replace(/\/$/, '');
                if (modelsUrl.endsWith('/chat/completions')) {
                    modelsUrl = modelsUrl.replace(/\/chat\/completions$/, '/models');
                } else if (!modelsUrl.endsWith('/models')) {
                    modelsUrl += '/models';
                }
            }

            console.log(`[${extensionName}] 通过前端直连获取模型列表: ${modelsUrl}`);
            const response = await fetch(modelsUrl, { method: 'GET', headers });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }
            const jsonResponse = await response.json();
            rawResponse = { data: responseTransformer(jsonResponse) };
        }

        const result = normalizeApiResponse(rawResponse);
        const models = result.data || [];

        if (result.error || !Array.isArray(models)) {
            const errorMessage = result.error?.message || 'API未返回有效的模型列表数组。';
            toastr.error(`获取模型列表失败: ${errorMessage}`, 'API错误');
            console.error(`[${extensionName}] 获取模型列表失败:`, rawResponse);
            return null;
        }

        const sortedModels = models.sort((a, b) => (a.id || a.model || '').localeCompare(b.id || b.model || ''));
        toastr.success(`成功获取 ${sortedModels.length} 个模型`, '操作成功');
        return sortedModels;

    } catch (error) {
        console.error(`[${extensionName}] 获取模型列表时发生网络或解析错误:`, error);
        toastr.error(`获取模型列表失败: ${error.message}`, 'API错误');
        return null;
    }
}

/**
 * 测试API连接
 * @param {object} apiSettings 
 * @returns {Promise<boolean>}
 */
export async function testApiConnection(apiSettings) {
    console.log(`[${extensionName}] 开始API连接测试...`);
    const { apiUrl, apiKey, apiMode, model, tavernProfile } = apiSettings;

    if (apiMode !== 'tavern' && (!apiUrl || !apiKey)) {
        toastr.error('请先填写 API URL 和 API Key。', '配置错误');
        return false;
    }
    if (apiMode !== 'tavern' && !model) {
        toastr.error('请选择一个模型用于测试。', '配置错误');
        return false;
    }

    if (apiMode === 'tavern' && !tavernProfile) {
        toastr.error('请选择一个酒馆连接预设用于测试。', '配置错误');
        return false;
    }

    const testMessages = [{ role: 'user', content: 'Say "Hi"' }];

    try {
        let result;
        if (apiMode === 'tavern') {
            let originalProfile = '';
            let responsePromise;
            try {
                originalProfile = await window.TavernHelper.triggerSlash('/profile');

                const context = getContext();
                const profile = context.extensionSettings?.connectionManager?.profiles.find(p => p.id === tavernProfile);

                if (!profile) throw new Error(`无法找到ID为 "${tavernProfile}" 的连接预设。`);
                const targetProfileName = profile.name;

                const currentProfile = await window.TavernHelper.triggerSlash('/profile');
                if (currentProfile !== targetProfileName) {
                    const escapedProfileName = targetProfileName.replace(/"/g, '\\"');
                    await window.TavernHelper.triggerSlash(`/profile await=true "${escapedProfileName}"`);
                }

                if (!profile.api) throw new Error(`预设 "${profile.name || profile.id}" 没有配置API。`);
                if (!profile.preset) throw new Error(`预设 "${profile.name || profile.id}" 没有选择预设。`);

                console.log(`[${extensionName}] 通过酒馆连接预设 "${profile.name || profile.id}" 测试（带超时）`);
                
                const requestPromise = context.ConnectionManagerRequestService.sendRequest(
                    profile.id,
                    testMessages
                );
                
                // 添加30秒超时（测试用更短的超时）
                responsePromise = withTimeout(
                    requestPromise,
                    30000,
                    '酒馆连接测试超时（30秒）'
                );
            } finally {
                const currentProfileAfterCall = await window.TavernHelper.triggerSlash('/profile');
                if (originalProfile && originalProfile !== currentProfileAfterCall) {
                    const escapedOriginalProfile = originalProfile.replace(/"/g, '\\"');
                    await window.TavernHelper.triggerSlash(`/profile await=true "${escapedOriginalProfile}"`);
                    console.log(`[${extensionName}] 已恢复原酒馆连接预设: "${originalProfile}"`);
                }
            }
            result = await responsePromise;
        }
        else if (apiMode === 'backend') {
            console.log(`[${extensionName}] 通过后端代理测试（带超时）`);
            
            const ajaxPromise = $.ajax({
                url: '/api/backends/chat-completions/generate',
                type: 'POST',
                contentType: 'application/json',
                headers: { 'Authorization': `Bearer ${apiKey}` },
                data: JSON.stringify({
                    messages: testMessages,
                    model: model,
                    max_tokens: 5,
                    temperature: apiSettings.temperature,
                    top_p: apiSettings.topP,
                    presence_penalty: apiSettings.presencePenalty,
                    frequency_penalty: apiSettings.frequencyPenalty,
                    stream: false,
                    chat_completion_source: 'custom',
                    custom_url: apiUrl,
                    api_key: apiKey,
                }),
            });
            
            // 添加30秒超时
            const rawResponse = await withTimeout(
                ajaxPromise,
                30000,
                '后端代理测试超时（30秒）'
            );
            result = normalizeApiResponse(rawResponse);
        } else { // 'frontend' or 'google'
            const useStreaming = apiSettings.useStreaming !== false;

            let finalApiUrl;
            let body;
            let headers = { 'Content-Type': 'application/json' };
            const isGoogleMode = apiMode === 'google';

            if (isGoogleMode) {
                const apiVersion = 'v1beta';
                const baseUrl = apiUrl.replace(/\/$/, '');
                finalApiUrl = useStreaming
                    ? `${baseUrl}/${apiVersion}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
                    : `${baseUrl}/${apiVersion}/models/${model}:generateContent?key=${apiKey}`;
                body = JSON.stringify(buildGoogleRequest(testMessages, { ...apiSettings, max_tokens: 5, temperature: 0.1 }));
            } else { // 'frontend'
                headers['Authorization'] = `Bearer ${apiKey}`;
                finalApiUrl = apiUrl.replace(/\/$/, '');
                if (!finalApiUrl.endsWith('/chat/completions')) {
                    finalApiUrl += '/chat/completions';
                }
                body = JSON.stringify({
                    messages: testMessages,
                    model: model,
                    max_tokens: 5,
                    temperature: apiSettings.temperature,
                    top_p: apiSettings.topP,
                    presence_penalty: apiSettings.presencePenalty,
                    frequency_penalty: apiSettings.frequencyPenalty,
                    stream: useStreaming,
                });
            }

            if (useStreaming) {
                console.log(`[${extensionName}] 通过前端直连流式测试: ${finalApiUrl}`);
                const content = await fetchWithStreamAndTimeout(finalApiUrl, { method: 'POST', headers, body }, isGoogleMode);
                result = { content };
            } else {
                console.log(`[${extensionName}] 通过前端直连非流式测试: ${finalApiUrl}`);

                const json = await fetchJsonWithTimeout(
                    finalApiUrl,
                    { method: 'POST', headers, body },
                    30000,
                    '前端直连测试超时（30秒）'
                );

                result = isGoogleMode
                    ? normalizeApiResponse(parseGoogleResponse(json))
                    : normalizeApiResponse(json);
            }
        }

        if (result.error) {
            throw new Error(result.error.message || JSON.stringify(result.error));
        }

        if (result.content !== undefined) {
            toastr.success(`测试成功！API返回: "${result.content}"`, 'API连接正常');
            return true;
        } else {
            throw new Error('API响应中未找到有效内容。');
        }

    } catch (error) {
        console.error(`[${extensionName}] API连接测试失败:`, error);
        toastr.error(`测试失败: ${error.message}`, 'API连接失败');
        return false;
    }
}
