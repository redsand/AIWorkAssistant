import { EmailClient } from "@azure/communication-email";
import { env } from "../../config/env";

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class AcsEmailClient {
  private client: EmailClient | null = null;
  private senderAddress: string;

  constructor() {
    this.senderAddress = env.ACS_SENDER_ADDRESS;
    if (env.ACS_CONNECTION_STRING) {
      this.client = new EmailClient(env.ACS_CONNECTION_STRING);
    }
  }

  isConfigured(): boolean {
    return !!(env.ACS_CONNECTION_STRING && this.senderAddress);
  }

  async sendEmail(params: {
    to: string;
    subject: string;
    plainText: string;
    html?: string;
  }): Promise<EmailSendResult> {
    if (!this.isConfigured() || !this.client) {
      return { success: false, error: "ACS not configured" };
    }

    const message = {
      senderAddress: this.senderAddress,
      content: {
        subject: params.subject,
        plainText: params.plainText,
        ...(params.html ? { html: params.html } : {}),
      },
      recipients: {
        to: [{ address: params.to }],
      },
    };

    try {
      const poller = await this.client.beginSend(message);
      const result = await poller.pollUntilDone();
      const status = (result as any).status ?? "Unknown";
      const messageId = (result as any).id ?? "acs-no-id";
      console.log(`[ACS Email] Sent to=${params.to} subject="${params.subject}" status=${status} id=${messageId}`);
      return { success: true, messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ACS Email] FAILED to=${params.to} subject="${params.subject}" error=${message}`);
      if (err instanceof Error && err.stack) {
        console.error(`[ACS Email] Stack: ${err.stack}`);
      }
      return { success: false, error: message };
    }
  }
}

export const acsEmailClient = new AcsEmailClient();