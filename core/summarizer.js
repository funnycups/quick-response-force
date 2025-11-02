// 快速响应部队 - 内容优化核心
// 由Cline移植并重构

import { extension_settings, getContext } from '/scripts/extensions.js';
import { extractContentByTag, replaceContentByTag, extractFullTagBlock } from '../utils/tagProcessor.js';
import { isGoogleEndpoint, convertToGoogleRequest, parseGoogleResponse, buildGoogleApiUrl } from '../utils/googleAdapter.js';
import { fetchWithStreamAndTimeout } from './api.js';

const extensionName = 'quick-response-force';

/**
 * 使用AI API优化给定的AI消息。
 * @param {object} latestAiMessage - 最新的AI消息对象。
 * @param {object[]} contextMessages - 上下文消息数组。
 * @returns {Promise<{optimizedContent: string}|null>}
 */
export async function checkAndFixWithAPI(latestAiMessage, contextMessages) {
    const settings = extension_settings[extensionName];

    if (!settings.enabled || !settings.optimizationEnabled) {
        return null;
    }
    if (!settings.apiUrl || !settings.apiUrl.trim()) {
        toastr.error('API URL 未在快速响应部队设置中配置。', '配置错误');
        return null;
    }

    console.groupCollapsed(`[${extensionName}] 开始优化任务... ${new Date().toLocaleTimeString()}`);
    console.time('优化任务总耗时');

    try {
        const originalMessage = latestAiMessage.mes;
        const targetTag = settings.optimizationTargetTag || 'div';

        // 提取需要优化的内容，如果找不到或为空，则中止任务
        const contentToProcess = extractFullTagBlock(originalMessage, targetTag);
        if (!contentToProcess || extractContentByTag(contentToProcess, targetTag)?.trim() === '') {
            console.warn(`[${extensionName}] 目标标签 <${targetTag}> 未找到或内容为空，跳过优化。`);
            console.timeEnd('优化任务总耗时');
            console.groupEnd();
            return null;
        }

        const context = getContext();
        const userName = context.name1 || '用户';
        const charName = context.name2 || '角色';

        // 准备上下文对话
        const lastUserMessage = contextMessages.find(msg => msg.is_user);
        const dialogueContext = contextMessages
            .map(msg => msg.mes?.trim() ? `${msg.is_user ? userName : charName}: ${msg.mes.trim()}` : null)
            .filter(Boolean)
            .join('\n');

        // 构建提示
        const messages = [];
        if (settings.mainPrompt?.trim()) {
            messages.push({ role: 'system', content: settings.mainPrompt.trim() });
        }
        if (settings.systemPrompt?.trim()) {
            messages.push({ role: 'system', content: settings.systemPrompt.trim() });
        }
        
        if (dialogueContext) {
            messages.push({ role: 'user', content: `[上下文参考]:\n${dialogueContext}` });
        }

        const coreContent = lastUserMessage 
            ? `${userName}: ${lastUserMessage.mes}\n${charName}: ${contentToProcess}` 
            : `${charName}: ${contentToProcess}`;
        messages.push({ role: 'user', content: `[核心处理内容]:\n${coreContent}` });

        console.groupCollapsed(`[${extensionName}] 发送给AI的最终请求内容`);
        console.dir(messages);
        console.groupEnd();

        // 调用API（使用流式传输）
        const isGoogle = isGoogleEndpoint(settings.apiUrl);
        const apiKey = settings.apiKey?.trim();
        const model = settings.model;
        const maxTokens = settings.maxTokens;
        const temperature = settings.temperature;
        
        let finalUrl;
        if (isGoogle) {
            // Google API流式端点
            const apiVersion = 'v1beta';
            const baseUrl = settings.apiUrl.trim().replace(/\/$/, '');
            finalUrl = `${baseUrl}/${apiVersion}/models/${model}:streamGenerateContent?alt=sse`;
            if (settings.apiUrl.includes('aiplatform.googleapis.com')) {
                finalUrl += `&access_token=${apiKey}`;
            } else {
                finalUrl += `&key=${apiKey}`;
            }
        } else {
            let path = settings.apiUrl.trim().replace(/\/v1\/$/, '').replace(/\/$/, '');
            finalUrl = `${path}/v1/chat/completions`;
        }
        
        const headers = { 'Content-Type': 'application/json' };
        if (isGoogle && settings.apiUrl.includes('aiplatform.googleapis.com')) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        } else if (!isGoogle) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const body = JSON.stringify(isGoogle
            ? convertToGoogleRequest({ model, messages, max_tokens: maxTokens, temperature })
            : { model, messages, max_tokens: maxTokens, temperature, stream: true }
        );

        console.log(`[${extensionName}] 发起流式优化请求...`);
        const apiResponse = await fetchWithStreamAndTimeout(finalUrl, { method: 'POST', headers, body }, isGoogle);

        if (!apiResponse) {
            console.error(`[${extensionName}] 未能从API响应中提取有效内容。`);
            throw new Error('AI响应为空或格式不正确。');
        }

        console.groupCollapsed(`[${extensionName}] 从AI收到的原始回复`);
        console.log(apiResponse);
        console.groupEnd();
        
        // 解析响应并替换内容
        const newContent = extractContentByTag(apiResponse, targetTag);
        if (newContent?.trim()) {
            const optimizedContent = replaceContentByTag(originalMessage, targetTag, newContent);
            console.log(`[${extensionName}] 内容优化成功。`);
            return { optimizedContent };
        } else {
            console.warn(`[${extensionName}] AI的回复中未找到有效的目标标签 <${targetTag}>，使用原始消息。`);
            return { optimizedContent: originalMessage };
        }

    } catch (error) {
        console.error(`[${extensionName}] 优化任务发生严重错误:`, error);
        toastr.error(`快速响应部队任务失败: ${error.message}`, '严重错误');
        return null;
    } finally {
        console.timeEnd('优化任务总耗时');
        console.groupEnd();
    }
}
