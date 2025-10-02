const { GoogleGenerativeAI, GoogleGenerativeAIFetchError, GoogleGenerativeAIError } = require("@google/generative-ai");

/**
 * MinecraftAI
 */
class MinecraftAI {
  /**
   * @param {string} apiKey - Google Generative AI API key
   * @param {string} modelName - 模型名稱 (e.g. "gemini-1.5-pro")
   * @param {number} maxOutputTokens - 最大輸出 token 數
   * @param {number} temperature - 回覆創意程度
   * @param {string} prompt - 系統提示詞
   * @param {boolean} aiCommandEnabled - 是否啟用 runCommand 功能
   */
  constructor(
    apiKey,
    modelName,
    maxOutputTokens,
    temperature,
    prompt,
    aiCommandEnabled
  ) {
    this.client = new GoogleGenerativeAI(apiKey);

    this.model = this.client.getGenerativeModel({
      model: modelName,
      systemInstruction: prompt,
      generationConfig: {
        temperature,
        maxOutputTokens,
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: "runCommand",
              description: "Only use this to execute Minecraft commands.",
              parameters: {
                type: "object",
                properties: {
                  command: {
                    type: "string",
                    description: "The command to run",
                  },
                },
                required: ["command"],
              },
            },
            {
              name: "newChatSession",
              description:
                "Start a new chat session only when the player explicitly requests it",
            },
          ].filter((fn) => aiCommandEnabled || fn.name === "newChatSession"),
        },
      ],
    });

    this.chat = this.model.startChat();
  }

  /** 開始新對話 */
  startNewChat() {
    console.log("開始新對話");
    this.chat = this.model.startChat();
  }

  /**
   * 擷取錯誤資訊
   * @param {GoogleGenerativeAIFetchError} e
   * @returns {string}
   */
  _extractErrorMessage(e) {
    let message = e.statusText
    if (e.status === 429) {
      const retryInfo = e.errorDetails.find(c => c['@type'].includes('RetryInfo'))
      if (retryInfo) {
        return `${message}, 請在 ${retryInfo.retryDelay} 後重試`
      }
    }
    if (e.status === 503) {
      return `${message}, 模型過載!請稍後再試`
    }
    return message
  }

  /**
   * 傳送訊息給 AI 模型並解析回應
   * @param {string | import('@google/generative-ai').Part[]} message - 要傳送的訊息或 parts
   * @returns {Promise<{text: string|null, commands: string[], newSession: boolean}>}
   */
  async _sendMessageAndParseResponse(message) {
    try {
      console.log("送出訊息：", JSON.stringify(message, null, 2));
      const result = await this.chat.sendMessage(message);
      const response = result.response;

      // 提取文字回應
      const candidate = response.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text || null;
      if (text) {
        console.log("回應文字：", text);
      }

      // 提取 Function Calls
      const commands = [];
      let newSession = false;
      const functionCalls = response.functionCalls() ?? [];
      for (const call of functionCalls) {
        console.log("偵測到函式呼叫：", call.name, call.args);
        if (call.name === "runCommand") {
          commands.push(call.args.command);
        } else if (call.name === "newChatSession") {
          this.startNewChat();
          newSession = true;
        }
      }

      return { text, commands, newSession };
    } catch (e) {
      let errorMessage = '§c發生錯誤: '
      if (e instanceof GoogleGenerativeAIError) {
        errorMessage += this._extractErrorMessage(e)
      } else {
        errorMessage += '未知錯誤'
      }
      console.error("發生錯誤: ", e);
      return { text: errorMessage, commands: [], newSession: false };
    }
  }

  /**
   * 處理玩家的文字訊息
   * @param {string} message - 玩家的訊息
   */
  async processUserMessage(message) {
    return this._sendMessageAndParseResponse(message);
  }

  /**
   * 將指令執行結果回傳給 AI
   * @param {string[]} results - 指令執行結果的陣列
   */
  async processCommandResults(results) {
    const functionResponseParts = results.map((result) => ({
      functionResponse: {
        name: "runCommand",
        response: { result },
      },
    }));

    return this._sendMessageAndParseResponse(functionResponseParts);
  }

  /** 測試連線 */
  async testConnection() {
    try {
      await this.chat.sendMessage("hello");
      return [true, null];
    } catch (e) {
      console.error("模型連線失敗：", e);
      return [false, extractErrorMessage(e.message || e.toString())];
    }
  }
}

module.exports = MinecraftAI;