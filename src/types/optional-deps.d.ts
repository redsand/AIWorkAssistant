/**
 * Type declarations for optional messaging platform dependencies.
 * These packages are only required if the corresponding platform is enabled.
 */

declare module "node-telegram-bot-api" {
  interface SendMessageOptions {
    parse_mode?: string;
    disable_notification?: boolean;
    reply_to_message_id?: number;
  }

  interface Message {
    message_id: number;
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
  }

  class TelegramBot {
    constructor(token: string, options?: { polling?: boolean });
    on(event: "message", callback: (msg: Message) => void): void;
    on(event: "polling_error", callback: (error: Error) => void): void;
    onText(regexp: RegExp, callback: (msg: Message) => void): void;
    sendMessage(chatId: number | string, text: string, options?: SendMessageOptions): Promise<Message>;
    stopPolling(): Promise<void>;
  }

  export default TelegramBot;
}

declare module "@slack/web-api" {
  interface ChatPostMessageResponse {
    ts: string;
  }

  class WebClient {
    constructor(token?: string);
    chat: {
      postMessage(params: Record<string, unknown>): Promise<ChatPostMessageResponse>;
    };
  }

  export { WebClient };
}

declare module "@slack/socket-mode" {
  class SocketModeClient {
    constructor(params: { appToken: string });
    on(event: "message" | "app_mention" | "error", callback: (event: any) => void): void;
    start(): Promise<void>;
    disconnect(): Promise<void>;
  }

  export { SocketModeClient };
}
