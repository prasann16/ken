#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { addCmd } from "./commands/add.ts";
import { searchCmd } from "./commands/search.ts";
import { listCmd } from "./commands/list.ts";
import { editCmd } from "./commands/edit.ts";
import { rmCmd } from "./commands/rm.ts";
import { pinCmd } from "./commands/pin.ts";
import { chatCmd } from "./commands/chat.ts";
import { viewCmd } from "./commands/view.ts";
import { telegramCmd } from "./commands/telegram.ts";
import { reembedCmd } from "./commands/reembed.ts";
import { updateCmd } from "./commands/update.ts";

const main = defineCommand({
  meta: {
    name: "ken",
    version: "0.1.0",
    description: "Personal memory layer — owned, LLM-agnostic, local-first",
  },
  subCommands: {
    add: addCmd,
    search: searchCmd,
    list: listCmd,
    edit: editCmd,
    rm: rmCmd,
    pin: pinCmd,
    chat: chatCmd,
    view: viewCmd,
    telegram: telegramCmd,
    reembed: reembedCmd,
    update: updateCmd,
  },
});

runMain(main);
