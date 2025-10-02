const websocket = require("nodejs-websocket");
const EventEmitter = require("events");
const { estimateFinalPayloadBytes, generateId } = require("./utils");

const WSS_MAXIMUM_BYTES = 661;

class MinecraftWebSocketServer extends EventEmitter {
  constructor(port, aiWakeWord, playerRegex, minecraftAI, cooldown = 5) {
    super(); // 初始化 EventEmitter
    this.port = port;
    this.aiWakeWord = aiWakeWord;
    this.playerRegex = playerRegex;
    this.minecraftAI = minecraftAI;
    this.cooldown = cooldown; // 新增：冷卻時間（秒）
    this.playerCooldowns = new Map(); // 新增：追蹤玩家的冷卻時間 K: playerName, V: timestamp

    this.wsServer = null;
    this.clientConn = null;

    this.commandBatches = new Map(); // K: batchId, V: { commandCount, results, resolve, reject, timeout }
    this.requestIdToBatchId = new Map(); // K: requestId, V: batchId
    this.requestTimeoutMs = 60_000;
  }

  start() {
    this.wsServer = websocket
      .createServer((conn) => this.onOpen(conn))
      .listen(this.port, () => {
        this.emit("log", `✅ WebSocket 伺服器已啟動於端口 ${this.port}`);
        this.emit(
          "status-update",
          `等待連線中... (/wsserver localhost:${this.port})`
        );
      });

    this.wsServer.on("error", (err) => this.onError(null, err));
  }

  stop(reason = "已停止") {
    if (this.wsServer) {
      this.wsServer.close(() => this.emit("log", "🛑 WebSocket 伺服器已停止"));
      this.wsServer = null;
    }

    if (this.clientConn) {
      this.clientConn?.socket.destroy();
      this.clientConn = null;
    }

    this.emit("status-update", reason);
  }

  onOpen(conn) {
    this.emit("log", `🔗 客戶端已連線: ${conn.socket.remoteAddress}`);
    this.emit("status-update", "連線成功");
    this.clientConn = conn;

    this.sendMessage("§l§b- WebSocket連接成功!");
    this.eventSubscribe("PlayerMessage");

    conn.on("text", (msg) => this.onMessage(conn, msg));
    conn.on("close", (code, reason) => this.onClose(conn, code, reason));
    conn.on("error", (err) => this.onError(conn, err));
  }

  onMessage(conn, message) {
    try {
      const data = JSON.parse(message);
      const header = data.header || {};
      const body = data.body || {};

      if (header.eventName === "PlayerMessage" && body.type === "chat") {
        const sender = body.sender;
        const msg = body.message;
        this.playerMessage(sender, msg);
      } else if (header.messagePurpose === "commandResponse") {
        const requestId = header.requestId;
        const statusMessage = body.statusMessage || "success";
        const batchId = this.requestIdToBatchId.get(requestId);

        if (batchId && this.commandBatches.has(batchId)) {
          this.requestIdToBatchId.delete(requestId);
          const batch = this.commandBatches.get(batchId);
          batch.results.push(statusMessage);

          if (batch.results.length === batch.commandCount) {
            clearTimeout(batch.timeout);
            this.commandBatches.delete(batchId);
            batch.resolve(batch.results); // 當批次中的所有指令都完成時，解析 Promise
          }
        }
      }
    } catch (err) {
      this.emit("log", `❌ 解析 JSON 時出錯: ${err.message}`);
    }
  }

  async playerMessage(sender, message) {
    // --- 新增：冷卻時間檢查邏輯 ---
    if (this.cooldown > 0) {
      const now = Date.now();
      const lastMessageTime = this.playerCooldowns.get(sender);

      if (lastMessageTime) {
        const timeElapsed = (now - lastMessageTime) / 1000; // 轉換為秒
        if (timeElapsed < this.cooldown) {
          const remainingTime = Math.ceil(this.cooldown - timeElapsed);
          this.sendMessage(
            `§e<AI> §c${sender} 的冷卻時間還有 ${remainingTime} 秒`
          );
          return; // 中斷後續執行
        }
      }
      this.playerCooldowns.set(sender, now); // 更新玩家的最後發言時間
    }
    // --- 冷卻邏輯結束 ---

    if (this.playerRegex && !new RegExp(this.playerRegex).test(sender)) return;
    if (this.aiWakeWord && !message.includes(this.aiWakeWord)) return;

    const initialTurn = await this.minecraftAI.processUserMessage(
      `<${sender}> ${message}`
    );
    await this.handleAITurn(initialTurn);
  }

  /**
   * 處理 AI 的一輪回應，可能包含文字和指令
   * @param {{text: string|null, commands: string[], newSession: boolean}} aiTurn
   */
  async handleAITurn(aiTurn) {
    if (aiTurn.newSession) {
      this.sendMessage("新對話已開始");
    }

    if (aiTurn.text) {
      this.sendMessage(`§e<AI> §r${aiTurn.text}`);
    }

    if (aiTurn.commands && aiTurn.commands.length > 0) {
      try {
        this.emit(
          "log",
          `準備執行 ${aiTurn.commands.length} 個指令...`
        );
        const results = await this.executeCommands(aiTurn.commands);
        this.emit(
          "log",
          `所有指令執行完畢，將 ${results.length} 個結果傳回 AI`
        );
        const nextAITurn = await this.minecraftAI.processCommandResults(results);
        await this.handleAITurn(nextAITurn); // 遞迴處理 AI 的下一輪回應
      } catch (error) {
        this.emit("log", `❌ 執行指令批次時出錯: ${error}`);
        this.sendMessage(`§c執行指令批次時出錯: ${error}`);
      }
    }
  }

  /**
   * 執行一批指令並等待所有結果
   * @param {string[]} commands
   * @returns {Promise<string[]>}
   */
  executeCommands(commands) {
    return new Promise((resolve, reject) => {
      const batchId = generateId();
      const requestIds = commands.map(() => generateId());

      const batch = {
        commandCount: commands.length,
        results: [],
        resolve,
        reject,
        timeout: setTimeout(() => {
          // 清理超時的批次
          requestIds.forEach((reqId) => this.requestIdToBatchId.delete(reqId));
          this.commandBatches.delete(batchId);
          reject(`指令批次執行超時 (${this.requestTimeoutMs}ms)`);
        }, this.requestTimeoutMs),
      };
      this.commandBatches.set(batchId, batch);

      commands.forEach((command, index) => {
        const requestId = requestIds[index];
        this.requestIdToBatchId.set(requestId, batchId);
        this.runCommand(command, requestId);
      });
    });
  }

  onClose(conn, code, reason) {
    if (!this.wsServer) return;
    this.emit("log", `🚫 客戶端已斷線: 程式碼 ${code}, 原因 ${reason}`);
    this.emit("status-update", "已暫停: Minecraft 離線");
  }

  onError(conn, err) {
    this.emit("log", `⚠️ 發生錯誤: ${err}`);
    this.emit("status-update", `已暫停: ${err?.message || "未知錯誤"}`);
  }

  sendMessage(message) {
    let remaining = message;
    while (remaining.length > 0) {
      let bestChunk = "";
      let bestLength = 0;

      if (estimateFinalPayloadBytes(remaining) <= WSS_MAXIMUM_BYTES) {
        bestChunk = remaining;
        bestLength = remaining.length;
      } else {
        for (let i = 1; i <= remaining.length; i++) {
          const candidate = remaining.substring(0, i);
          if (estimateFinalPayloadBytes(candidate) > WSS_MAXIMUM_BYTES) break;
          bestChunk = candidate;
          bestLength = i;
        }
      }

      const escapedCommand = JSON.stringify(bestChunk);
      this.runCommand(`tellraw @a {"rawtext":[{"text":${escapedCommand}}]}`);
      remaining = remaining.substring(bestLength);
    }
  }

  /**
   * 執行單一指令
   * @param {string} command - 要執行的指令
   * @param {string | null} requestId - 用於追蹤的請求 ID
   */
  runCommand(command, requestId = null) {
    const reqId = requestId || generateId();
    const payload = JSON.stringify({
      header: {
        requestId: reqId,
        messagePurpose: "commandRequest",
        version: 17104896,
      },
      body: {
        commandLine: command,
        version: 17104896,
      },
    });

    if (Buffer.byteLength(payload, "utf8") > WSS_MAXIMUM_BYTES) {
      this.sendMessage("§c[runCommand] 指令太長無法執行");
      this.emit("log", `⚠️ 傳送的酬載過大 (${payload.length} 位元組)`);
      return;
    }

    if (requestId) {
      this.sendMessage(`§e[runCommand] §r: ${command}`);
      this.emit("log", `[${reqId.slice(0, 5)}] 執行中: ${command}`);
    }

    if (this.clientConn && !this.clientConn.closed) {
      this.clientConn.sendText(payload);
    }
  }

  eventSubscribe(eventName) {
    const payload = {
      header: {
        requestId: crypto.randomUUID(),
        messagePurpose: "subscribe",
        version: 17104896,
      },
      body: {
        eventName,
      },
    };
    this.clientConn?.sendText(JSON.stringify(payload));
    this.emit("log", `🔔 已訂閱事件: ${eventName}`);
  }
}

module.exports = MinecraftWebSocketServer;