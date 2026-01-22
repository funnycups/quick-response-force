/**
 * Remove old `qrf_plot` payloads from chat history, keeping only the latest N saves.
 *
 * @param {Array<object>} chat - SillyTavern chat array (context.chat)
 * @param {number} keepLatestCount - Keep the latest N `qrf_plot` entries. <= 0 disables pruning.
 * @returns {number} removedCount
 */
export function pruneQrfPlotHistory(chat, keepLatestCount) {
    const retention = Number(keepLatestCount);
    if (!Array.isArray(chat) || !Number.isFinite(retention) || retention <= 0) return 0;

    const plotIndexes = [];
    for (let i = 0; i < chat.length; i++) {
        if (chat[i] && Object.prototype.hasOwnProperty.call(chat[i], 'qrf_plot')) {
            plotIndexes.push(i);
        }
    }

    if (plotIndexes.length <= retention) return 0;

    const indexesToPrune = plotIndexes.slice(0, plotIndexes.length - retention);
    for (const index of indexesToPrune) {
        delete chat[index].qrf_plot;
    }

    return indexesToPrune.length;
}

