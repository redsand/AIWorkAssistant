import nodemailer from "nodemailer";
import { env } from "../../config/env";
import { acsEmailClient } from "../../integrations/microsoft/acs-email-client";

// ── Provider interface ──

export interface EmailProvider {
  sendEmail(params: {
    to: string;
    subject: string;
    plainText: string;
    html?: string;
  }): Promise<boolean>;
  isConfigured(): boolean;
  name(): string;
}

// ── SMTP provider (existing nodemailer logic) ──

class SmtpEmailProvider implements EmailProvider {
  private transporter: nodemailer.Transporter | null = null;

  private getTransporter(): nodemailer.Transporter | null {
    if (!env.ESCALATION_SMTP_HOST) return null;
    if (!this.transporter) {
      console.log(`[Email/SMTP] Initializing transport: ${env.ESCALATION_SMTP_HOST}:${env.ESCALATION_SMTP_PORT}`);
      this.transporter = nodemailer.createTransport({
        host: env.ESCALATION_SMTP_HOST,
        port: env.ESCALATION_SMTP_PORT,
        secure: env.ESCALATION_SMTP_SECURE,
        auth: env.ESCALATION_SMTP_USER
          ? { user: env.ESCALATION_SMTP_USER, pass: env.ESCALATION_SMTP_PASS }
          : undefined,
      });
    }
    return this.transporter;
  }

  isConfigured(): boolean {
    return !!env.ESCALATION_SMTP_HOST;
  }

  name(): string {
    return "smtp";
  }

  async sendEmail(params: {
    to: string;
    subject: string;
    plainText: string;
    html?: string;
  }): Promise<boolean> {
    const transport = this.getTransporter();
    if (!transport) {
      console.log(`[Email/SMTP] Not configured — skipping email to ${params.to}: ${params.subject}`);
      return false;
    }

    const from = env.ESCALATION_EMAIL_FROM || "alerts@ai-work-assistant";
    console.log(`[Email/SMTP] Sending to=${params.to} from=${from} subject="${params.subject}"`);

    try {
      const result = await transport.sendMail({
        from,
        to: params.to,
        subject: params.subject,
        text: params.plainText,
        ...(params.html ? { html: params.html } : {}),
      });
      console.log(`[Email/SMTP] Delivered to=${params.to} messageId=${result.messageId} response=${result.response}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as any)?.code;
      console.error(`[Email/SMTP] FAILED to=${params.to} subject="${params.subject}" code=${code || "unknown"} error=${message}`);
      if (err instanceof Error && err.stack) {
        console.error(`[Email/SMTP] Stack: ${err.stack}`);
      }
      return false;
    }
  }
}

// ── ACS provider adapter ──

class AcsEmailProvider implements EmailProvider {
  isConfigured(): boolean {
    return acsEmailClient.isConfigured();
  }

  name(): string {
    return "acs";
  }

  async sendEmail(params: {
    to: string;
    subject: string;
    plainText: string;
    html?: string;
  }): Promise<boolean> {
    const result = await acsEmailClient.sendEmail(params);
    return result.success;
  }
}

// ── Provider selection ──

const smtpProvider = new SmtpEmailProvider();
const acsProvider = new AcsEmailProvider();

function getActiveProvider(): EmailProvider {
  if (env.EMAIL_PROVIDER === "smtp") return smtpProvider;
  if (env.EMAIL_PROVIDER === "acs") return acsProvider;
  // "auto": prefer ACS (M365), fall back to SMTP
  if (acsProvider.isConfigured()) return acsProvider;
  return smtpProvider;
}

// ── Public API ──

export async function sendEmail(params: {
  to: string;
  subject: string;
  plainText: string;
  html?: string;
}): Promise<boolean> {
  const provider = getActiveProvider();
  if (!provider.isConfigured()) {
    console.log(`[Email] No provider configured (${provider.name()}) — skipping email to ${params.to}: ${params.subject}`);
    return false;
  }
  return provider.sendEmail(params);
}

export async function sendEscalationEmail(
  to: string,
  subject: string,
  body: string,
): Promise<boolean> {
  return sendEmail({ to, subject, plainText: body });
}

export function isEmailConfigured(): boolean {
  const provider = getActiveProvider();
  return provider.isConfigured() && !!env.ESCALATION_EMAIL_TO;
}

export function getActiveProviderName(): string {
  return getActiveProvider().name();
}