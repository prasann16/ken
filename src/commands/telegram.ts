import { defineCommand } from "citty";
import { runBot } from "../telegram/bot.ts";
import { withErrors } from "../util/cli.ts";
import { KenError } from "../util/err.ts";

export const telegramCmd = defineCommand({
  meta: {
    name: "telegram",
    description: "Run the Telegram bot (long-polling)",
  },
  args: {
    token: { type: "string", description: "Bot token (else TELEGRAM_BOT_TOKEN env)", default: "" },
    allow: { type: "string", description: "Comma-separated chat_ids allowed to talk to the bot (else ALLOWED_CHAT_IDS env)", default: "" },
  },
  run: withErrors(async (args) => {
    const token = (args.token as string) || process.env.TELEGRAM_BOT_TOKEN || "";
    if (!token) {
      throw new KenError("CONFIG", "no Telegram token provided", {
        hint: "pass --token=... or set TELEGRAM_BOT_TOKEN env var",
      });
    }
    const allowStr = (args.allow as string) || process.env.ALLOWED_CHAT_IDS || "";
    const allowedChatIds = new Set(
      allowStr.split(",").map((s) => s.trim()).filter(Boolean).map(Number),
    );
    if (allowedChatIds.size === 0) {
      throw new KenError("CONFIG", "no allowed chat_ids provided", {
        hint: "pass --allow=123456 or set ALLOWED_CHAT_IDS env var",
      });
    }
    process.on("SIGINT", () => {
      process.stdout.write("\nstopping…\n");
      process.exit(0);
    });
    await runBot({ token, allowedChatIds });
  }),
});
