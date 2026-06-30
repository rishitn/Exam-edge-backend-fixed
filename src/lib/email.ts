import nodemailer from "nodemailer";
import { env } from "../config/env";
import { createLogger } from "./logger";

const log = createLogger("email");

// =============================================================================
// Email Service — Nodemailer with SMTP
// =============================================================================

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD,
    },
    pool: true,
    maxConnections: 5,
    rateDelta: 1000,
    rateLimit: 10,
  });

  return transporter;
}

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(options: EmailOptions): Promise<void> {
  try {
    await getTransporter().sendMail({
      from: env.EMAIL_FROM,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
    log.info({ to: options.to, subject: options.subject }, "Email sent");
  } catch (err) {
    log.error({ err, to: options.to }, "Email send failed");
    // Don't throw — email failures shouldn't break the request flow
    // In production, add to a retry queue instead
  }
}

// =============================================================================
// Email Templates
// =============================================================================

export async function sendEmailVerification(
  email: string,
  name: string,
  verifyUrl: string
): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Verify your ExamEdge email",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome to ExamEdge, ${name}!</h2>
        <p>Please verify your email address to activate your account.</p>
        <a href="${verifyUrl}"
           style="display:inline-block; padding:12px 24px; background:#6366f1;
                  color:white; text-decoration:none; border-radius:6px; margin:16px 0;">
          Verify Email
        </a>
        <p style="color:#666; font-size:14px;">
          This link expires in 24 hours. If you didn't create an account, ignore this email.
        </p>
      </div>
    `,
    text: `Welcome to ExamEdge, ${name}! Verify your email: ${verifyUrl}`,
  });
}

export async function sendPasswordResetEmail(
  email: string,
  name: string,
  resetUrl: string
): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Reset your ExamEdge password",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Password Reset</h2>
        <p>Hi ${name}, you requested a password reset.</p>
        <a href="${resetUrl}"
           style="display:inline-block; padding:12px 24px; background:#6366f1;
                  color:white; text-decoration:none; border-radius:6px; margin:16px 0;">
          Reset Password
        </a>
        <p style="color:#666; font-size:14px;">
          This link expires in 30 minutes. If you didn't request this, ignore this email.
        </p>
      </div>
    `,
    text: `Reset your ExamEdge password: ${resetUrl}`,
  });
}

export async function sendWelcomeEmail(email: string, name: string): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Welcome to ExamEdge 🎯",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>You're in, ${name}!</h2>
        <p>Your ExamEdge account is ready. Start practicing with free mock tests today.</p>
        <a href="${env.FRONTEND_URL}/tests"
           style="display:inline-block; padding:12px 24px; background:#6366f1;
                  color:white; text-decoration:none; border-radius:6px; margin:16px 0;">
          Browse Tests
        </a>
      </div>
    `,
  });
}

export async function sendAdminCredentialsEmail(
  email: string,
  name: string,
  password: string
): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Your ExamEdge Admin Account",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Admin Account Created</h2>
        <p>Hi ${name}, your ExamEdge admin account has been created.</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Temporary Password:</strong> <code>${password}</code></p>
        <a href="${env.ADMIN_URL}/login"
           style="display:inline-block; padding:12px 24px; background:#6366f1;
                  color:white; text-decoration:none; border-radius:6px; margin:16px 0;">
          Login to Admin Panel
        </a>
        <p style="color:#e11d48; font-size:14px;">
          Please change your password immediately after logging in.
        </p>
      </div>
    `,
  });
}
