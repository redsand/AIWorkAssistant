import nodemailer from "nodemailer";
import { env } from "../../config/env";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!env.ESCALATION_SMTP_HOST) return null;

  if (!transporter) {
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
    console.log(`[Email] SMTP not configured — would email ${to}: ${subject}`);
    return false;
  }

  try {
    await transport.sendMail({
      from: env.ESCALATION_EMAIL_FROM,
      to,
      subject,
      text: body,
    });
    console.log(`[Email] Sent to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[Email] Failed to send to ${to}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

export function isEmailConfigured(): boolean {
  return !!env.ESCALATION_SMTP_HOST && !!env.ESCALATION_EMAIL_TO;
}