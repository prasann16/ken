// IMAP + SMTP email integration. Works with Gmail, iCloud, Outlook, Yahoo,
// Fastmail, Proton (via Bridge), or any standard IMAP/SMTP provider.
// User authenticates with an app password — no OAuth.

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser, type AddressObject } from "mailparser";
import { loadConfig } from "../config.ts";
import { KenError } from "../util/err.ts";

type ProviderSettings = {
  imapHost: string;
  smtpHost: string;
  archiveFolder: string;
  trashFolder: string;
};

const PROVIDERS: Record<string, ProviderSettings> = {
  "gmail.com":      { imapHost: "imap.gmail.com",        smtpHost: "smtp.gmail.com",        archiveFolder: "[Gmail]/All Mail", trashFolder: "[Gmail]/Trash" },
  "googlemail.com": { imapHost: "imap.gmail.com",        smtpHost: "smtp.gmail.com",        archiveFolder: "[Gmail]/All Mail", trashFolder: "[Gmail]/Trash" },
  "icloud.com":     { imapHost: "imap.mail.me.com",      smtpHost: "smtp.mail.me.com",      archiveFolder: "Archive",           trashFolder: "Deleted Messages" },
  "me.com":         { imapHost: "imap.mail.me.com",      smtpHost: "smtp.mail.me.com",      archiveFolder: "Archive",           trashFolder: "Deleted Messages" },
  "mac.com":        { imapHost: "imap.mail.me.com",      smtpHost: "smtp.mail.me.com",      archiveFolder: "Archive",           trashFolder: "Deleted Messages" },
  "outlook.com":    { imapHost: "outlook.office365.com", smtpHost: "smtp.office365.com",    archiveFolder: "Archive",           trashFolder: "Deleted Items" },
  "hotmail.com":    { imapHost: "outlook.office365.com", smtpHost: "smtp.office365.com",    archiveFolder: "Archive",           trashFolder: "Deleted Items" },
  "live.com":       { imapHost: "outlook.office365.com", smtpHost: "smtp.office365.com",    archiveFolder: "Archive",           trashFolder: "Deleted Items" },
  "yahoo.com":      { imapHost: "imap.mail.yahoo.com",   smtpHost: "smtp.mail.yahoo.com",   archiveFolder: "Archive",           trashFolder: "Trash" },
  "fastmail.com":   { imapHost: "imap.fastmail.com",     smtpHost: "smtp.fastmail.com",     archiveFolder: "Archive",           trashFolder: "Trash" },
};

type Resolved = {
  user: string;
  password: string;
  imapHost: string;
  smtpHost: string;
  archiveFolder: string;
  trashFolder: string;
  isGmail: boolean;
};

function resolveConfig(): Resolved {
  const e = loadConfig().email;
  if (!e.user || !e.password) {
    throw new KenError("CONFIG", "email not configured", {
      hint: "in ~/.ken/config.toml set [email] user = '...' and password = '<app password>' — generate the app password from your provider's account settings",
    });
  }
  const domain = e.user.split("@")[1]?.toLowerCase() ?? "";
  const detected = PROVIDERS[domain] ?? null;
  const imapHost = e.imap_host || detected?.imapHost;
  const smtpHost = e.smtp_host || detected?.smtpHost;
  const archiveFolder = e.archive_folder || detected?.archiveFolder || "Archive";
  const trashFolder = e.trash_folder || detected?.trashFolder || "Trash";
  if (!imapHost || !smtpHost) {
    throw new KenError("CONFIG", `unknown email provider for ${e.user}`, {
      hint: "set email.imap_host and email.smtp_host in ~/.ken/config.toml",
    });
  }
  return {
    user: e.user,
    password: e.password,
    imapHost,
    smtpHost,
    archiveFolder,
    trashFolder,
    isGmail: imapHost === "imap.gmail.com",
  };
}

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const cfg = resolveConfig();
  const client = new ImapFlow({
    host: cfg.imapHost,
    port: 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
  });
  try {
    await client.connect();
  } catch (e) {
    throw new KenError("EXTERNAL_TOOL", `IMAP connect failed: ${(e as Error).message}`, {
      hint: "wrong app password or IMAP not enabled — check your provider's settings",
    });
  }
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* swallow */ }
  }
}

function formatAddress(addr: { name?: string; address?: string } | undefined): string {
  if (!addr) return "";
  if (addr.name && addr.address) return `${addr.name} <${addr.address}>`;
  return addr.address ?? "";
}

function snippetFromText(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

export type EmailSummary = {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
};

export async function searchEmails(query: string, limit = 10): Promise<EmailSummary[]> {
  return withImap(async (client) => {
    const cfg = resolveConfig();
    await client.mailboxOpen("INBOX");

    // Gmail supports its native search via X-GM-RAW (e.g. "from:alice newer_than:7d").
    // Other providers fall back to basic IMAP search syntax.
    let uids: number[] = [];
    try {
      const opts = cfg.isGmail
        ? ({ gmailRaw: query } as Record<string, unknown>)
        : translateQuery(query);
      const res = await client.search(opts);
      uids = Array.isArray(res) ? res : [];
    } catch {
      uids = await client.search({ all: true });
    }
    if (uids.length === 0) return [];

    // Newest first, cap to limit.
    const targets = uids.sort((a, b) => b - a).slice(0, limit);

    const out: EmailSummary[] = [];
    for await (const msg of client.fetch(
      targets,
      { uid: true, envelope: true, source: true },
      { uid: true },
    )) {
      const env = msg.envelope ?? {};
      let snippet = "";
      if (msg.source) {
        try {
          const parsed = await simpleParser(msg.source);
          snippet = snippetFromText(parsed.text || "");
        } catch {
          // mailparser failed — leave snippet empty rather than crash
        }
      }
      out.push({
        id: String(msg.uid),
        from: formatAddress(env.from?.[0]),
        subject: env.subject ?? "",
        date: env.date ? new Date(env.date).toISOString() : "",
        snippet,
      });
    }
    return out;
  });
}

export type EmailFull = {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  body: string;
};

export async function getEmail(id: string): Promise<EmailFull | null> {
  return withImap(async (client) => {
    await client.mailboxOpen("INBOX");
    const uid = Number(id);
    if (!Number.isFinite(uid)) return null;
    for await (const msg of client.fetch(
      [uid],
      { uid: true, envelope: true, source: true },
      { uid: true },
    )) {
      const env = msg.envelope ?? {};
      let body = "";
      if (msg.source) {
        try {
          const parsed = await simpleParser(msg.source);
          body = parsed.text || stripHtml(parsed.html || "") || "";
        } catch {
          body = "(could not parse message body)";
        }
      }
      const toAddr = formatAddressList(env.to);
      const ccAddr = formatAddressList(env.cc);
      return {
        id: String(msg.uid),
        from: formatAddress(env.from?.[0]),
        to: toAddr,
        cc: ccAddr,
        subject: env.subject ?? "",
        date: env.date ? new Date(env.date).toISOString() : "",
        body: body.slice(0, 8000),  // safety cap so we don't shovel novels into the LLM
      };
    }
    return null;
  });
}

function formatAddressList(addrs: { name?: string; address?: string }[] | undefined): string {
  if (!Array.isArray(addrs) || addrs.length === 0) return "";
  return addrs.map(formatAddress).filter(Boolean).join(", ");
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Translate a small subset of Gmail-style query for non-Gmail providers.
function translateQuery(query: string): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const since = query.match(/newer_than:(\d+)d/);
  if (since) q.since = new Date(Date.now() - Number(since[1]) * 86_400_000);
  const from = query.match(/from:(\S+)/);
  if (from) q.from = from[1];
  const subject = query.match(/subject:"([^"]+)"|subject:(\S+)/);
  if (subject) q.subject = subject[1] ?? subject[2];
  const unread = /\bis:unread\b/.test(query);
  if (unread) q.seen = false;
  const text = query.replace(/(newer_than:\S+|from:\S+|subject:"[^"]+"|subject:\S+|is:unread)/g, "").trim();
  if (text) q.body = text;
  if (Object.keys(q).length === 0) q.all = true;
  return q;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  body: string;
  inReplyToId?: string;
  cc?: string;
}): Promise<{ messageId: string }> {
  const cfg = resolveConfig();

  // For replies, fetch the original's Message-ID + References for proper threading.
  let inReplyToHeader: string | undefined;
  let referencesHeader: string | undefined;
  if (opts.inReplyToId) {
    await withImap(async (client) => {
      await client.mailboxOpen("INBOX");
      const id = Number(opts.inReplyToId);
      for await (const msg of client.fetch([id], { uid: true, envelope: true, headers: ["message-id", "references"] })) {
        const headers = msg.headers?.toString("utf8") ?? "";
        const msgIdMatch = headers.match(/^Message-ID:\s*(<[^>]+>)/im);
        const refsMatch = headers.match(/^References:\s*(.+)$/im);
        inReplyToHeader = msgIdMatch?.[1];
        referencesHeader = refsMatch?.[1]?.trim();
        if (inReplyToHeader && !referencesHeader) referencesHeader = inReplyToHeader;
        else if (inReplyToHeader && referencesHeader) referencesHeader = `${referencesHeader} ${inReplyToHeader}`;
      }
    });
  }

  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: cfg.user, pass: cfg.password },
  });

  const info = await transporter.sendMail({
    from: cfg.user,
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    text: opts.body,
    inReplyTo: inReplyToHeader,
    references: referencesHeader,
  });
  return { messageId: info.messageId ?? "" };
}

export async function archiveEmails(ids: string[]): Promise<number> {
  return withImap(async (client) => {
    const cfg = resolveConfig();
    await client.mailboxOpen("INBOX");
    const uids = ids.map((n) => Number(n)).filter((n) => Number.isFinite(n));
    if (uids.length === 0) return 0;
    await client.messageMove(uids, cfg.archiveFolder, { uid: true });
    return uids.length;
  });
}

export async function trashEmails(ids: string[]): Promise<number> {
  return withImap(async (client) => {
    const cfg = resolveConfig();
    await client.mailboxOpen("INBOX");
    const uids = ids.map((n) => Number(n)).filter((n) => Number.isFinite(n));
    if (uids.length === 0) return 0;
    await client.messageMove(uids, cfg.trashFolder, { uid: true });
    return uids.length;
  });
}

export type UnsubscribeResult =
  | { status: "unsubscribed"; from: string }
  | { status: "manual_required"; from: string; url: string }
  | { status: "no_unsubscribe_method"; from: string }
  | { status: "request_failed"; from: string; http: number };

export async function unsubscribeEmail(id: string): Promise<UnsubscribeResult> {
  const { from, listUnsub, listUnsubPost } = await withImap(async (client) => {
    await client.mailboxOpen("INBOX");
    const uid = Number(id);
    for await (const msg of client.fetch([uid], { uid: true, envelope: true, headers: ["list-unsubscribe", "list-unsubscribe-post", "from"] })) {
      const env = msg.envelope ?? {};
      const headers = msg.headers?.toString("utf8") ?? "";
      const lu = headers.match(/^List-Unsubscribe:\s*(.+)$/im)?.[1]?.trim() ?? "";
      const lup = headers.match(/^List-Unsubscribe-Post:\s*(.+)$/im)?.[1]?.trim() ?? "";
      return { from: formatAddress(env.from?.[0]), listUnsub: lu, listUnsubPost: lup };
    }
    return { from: "", listUnsub: "", listUnsubPost: "" };
  });

  if (!listUnsub) return { status: "no_unsubscribe_method", from };
  const httpsMatch = listUnsub.match(/<(https:[^>]+)>/);
  if (!httpsMatch) return { status: "no_unsubscribe_method", from };
  const url = httpsMatch[1]!;
  if (listUnsubPost.toLowerCase().includes("one-click")) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    if (res.ok) return { status: "unsubscribed", from };
    return { status: "request_failed", from, http: res.status };
  }
  return { status: "manual_required", from, url };
}
