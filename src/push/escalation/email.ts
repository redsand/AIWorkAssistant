import nodemailer from "nodemailer";
import { env } from "../../config/env";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!env.ESCALATION_SMTP_HOST) return null;

  if (!transporter) {
    console.log(`[Email] Initializing SMTP transport: ${env.ESCALATION_SMTP_HOST}:${env.ESCALATION_SMTP_PORT} (secure=${env.ESCALATION_SMTP_SECURE}, auth=${env.ESCALATION_SMTP_USER ? "yes" : "no"})`);
    transporter = nodemailer.createTransport({
      host: env.ESCALATION_SMTP_HOST,
      port: env.ESCALATION_SMTP_PORT,
      secure: env.ESCALATION_SMTP_SECURE,
      auth: env.ESCALATION_SMTP_USER
        ? { user: env.ESCALATION_SMTP_USER, pass: env.ESCALATION_SMTP_PASS }
        : undefined,
    });
  }

  return transporter;
}

export async function sendEscalationEmail(
  to: string,
  subject: string,
  body: string,
): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) {
    console.log(`[Email] SMTP not configured — skipping email to ${to}: ${subject}`);
    return false;
  }

  const from = env.ESCALATION_EMAIL_FROM || "alerts@ai-work-assistant";
  console.log(`[Email] Sending to=${to} from=${from} subject="${subject}"`);

  try {
    const result = await transport.sendMail({
      from,
      to,
      subject,
      text: body,
    });
    console.log(`[Email] Delivered to=${to} messageId=${result.messageId} response=${result.response}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as any)?.code;
    const command = (err as any)?.command;
    console.error(`[Email] FAILED to=${to} subject="${subject}" code=${code || "unknown"} command=${command || "unknown"} error=${message}`);
    if (err instanceof Error && err.stack) {
      console.error(`[Email] Stack: ${err.stack}`);
    }
    return false;
  }
}

export function isEmailConfigured(): boolean {
  return !!env.ESCALATION_SMTP_HOST && !!env.ESCALATION_EMAIL_TO;
}