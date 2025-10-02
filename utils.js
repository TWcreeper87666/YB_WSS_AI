/**
 * 估計最終有效酬載的位元組數
 * @param {string} message - 訊息字串
 * @returns {number} 估計的位元組數
 */
function estimateFinalPayloadBytes(message) {
  const usedBytes = 190;
  const backtickEscapeLength = (message.match(/`/g) || []).length * 5;
  const escapedMessage = JSON.stringify(JSON.stringify(message));
  const textLength = Buffer.byteLength(escapedMessage, "utf8");
  return usedBytes + backtickEscapeLength + textLength;
}

// 純 JS 生成短 ID
function generateId(length = 3) {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < length; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

module.exports = {
  estimateFinalPayloadBytes,
  generateId,
};
