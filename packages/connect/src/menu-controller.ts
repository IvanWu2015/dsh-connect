/**
 * Menu navigation controller.
 *
 * Renders card menus and routes button / dropdown selections to the per-chat
 * driver (`MenuHost`). The driver owns session / queue / lock runtime state;
 * this controller only needs the read-only hosts (messages, adapter, bindings)
 * plus the side-effect callbacks that perform an action, so the menu concern is
 * split out without the controller reaching into the driver's mutable state.
 * @module dsh-connect/menu-controller
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { Messages, Language } from "./i18n.js";
import type { ChoiceOption, ChannelAdapter, InboundMessage, OutboundTarget } from "./types.js";
import type { BindingStore } from "./binding.js";
import type { NotifyLevel } from "./stream.js";
import type { MenuId, MenuItem } from "./menus.js";

/** Read-only surface `MenuController` needs from the per-chat driver. */
export interface MenuHost {
  readonly t: Messages;
  workDir: string;
  readonly adapter: ChannelAdapter;
  readonly language: Language;
  readonly bindings: BindingStore;
  readonly channel: string;
  readonly chatKey: string;
  readonly notifyLevel: NotifyLevel;
  readonly progressTimeoutMs: number;
  readonly ctx: Context;
  defaultSelection(): ModelSelection;
  listWorkspaces(): { path: string; title: string }[];
  menuTitle(menuId: MenuId): string;
  rootMenuSections(): readonly { title: string; ids: readonly string[]; columnsPerRow?: number }[];
  newChat(msg: InboundMessage): Promise<void>;
  setLanguage(lang: Language, target: OutboundTarget, msg: InboundMessage): Promise<void>;
  setReasoning(effort: string | undefined, msg: InboundMessage): Promise<void>;
  setNotifyLevel(level: NotifyLevel, target: OutboundTarget, msg: InboundMessage): Promise<void>;
  setProgressTimeout(ms: number, target: OutboundTarget, msg: InboundMessage): Promise<void>;
  setModel(provider: string, model: string, msg: InboundMessage): Promise<void>;
  showStatus(target: OutboundTarget): Promise<void>;
  showTasks(target: OutboundTarget): Promise<void>;
  showHistory(target: OutboundTarget, limit: number): Promise<void>;
  showGoals(target: OutboundTarget): Promise<void>;
  showSchedule(target: OutboundTarget): Promise<void>;
  showPlugins(target: OutboundTarget): Promise<void>;
  showSettings(target: OutboundTarget): Promise<void>;
  compact(target: OutboundTarget): Promise<void>;
  collectWorkdirSessions(): Promise<{ sessionId: string; title: string }[]>;
  switchTo(sessionId: string, ownerKey: string): Promise<void>;
  confirmAction(target: OutboundTarget, promptText: string, messageId?: string): Promise<boolean>;
}

export class MenuController {
  constructor(private readonly host: MenuHost) {}

    async openMenu(target: OutboundTarget, msg: InboundMessage, menuId: MenuId, stack: MenuId[] = [], cardId?: string): Promise<void> {
    const items = await this.menuItems(menuId);
    const options: ChoiceOption[] = items.map((i) => ({ id: i.id, label: i.label }));
    options.push({ id: "menu:exit", label: this.host.t.menuExit });
    if (stack.length > 0) options.push({ id: "menu:back", label: this.host.t.menuBack });
    
    // Determine columns per row based on menu type
    // Workspace and chat lists use 1 column (full width), others use 2 columns
    const columnsPerRow = (menuId === "workspace" || menuId === "chat") ? 1 : 2;
    
    const { choice, messageId } = await this.host.adapter.promptChoice(
      target,
      {
        title: this.host.menuTitle(menuId),
        options,
        columnsPerRow,
        // Item-heavy menus (model / session / workspace) auto-render as a
        // single select_static dropdown; small menus stay as buttons. Root's
        // grouped sections are exempt (they always stay as a button grid).
        render: "auto",
        ...(menuId === "root" ? { sections: this.host.rootMenuSections(), footer: this.host.t.rootMenuFooter } : {}),
      },
      cardId,
    );
    if (choice === undefined) return;
    if (choice === "menu:exit") {
      await this.host.adapter.closeMenu(messageId, this.host.t.menuClosed);
      return;
    }
    if (choice === "menu:back") {
      const parent = stack[stack.length - 1];
      await this.openMenu(target, msg, parent, stack.slice(0, -1), messageId);
      return;
    }
    const item = items.find((i) => i.id === choice);
    if (item === undefined) {
      // The tap belonged to a previous card generation (e.g. a rapid second
      // tap on the old menu while the new one was still being redrawn). Don't
      // silently swallow it: redraw the current menu so the chain stays usable.
      await this.openMenu(target, msg, menuId, stack, messageId);
      return;
    }
    const feedback = await item.onSelect(target, msg, messageId);
    if (item.leaf === true) {
      // Every leaf press must answer visibly: send the action's result feedback
      // (if any) before returning to the root menu on the same card.
      if (feedback !== undefined && feedback !== "") {
        await this.host.adapter.sendText(target, feedback).catch(() => undefined);
      }
      await this.openMenu(target, msg, "root", [], messageId);
    }
  }

    private async menuItems(menuId: MenuId): Promise<MenuItem[]> {
    switch (menuId) {
      case "root":
        return [
          { id: "workspace", label: this.host.t.menuWorkspaceAction, onSelect: (t, m, cardId) => this.openMenu(t, m, "workspace", ["root"], cardId) },
          { id: "chat", label: this.host.t.menuChatAction, onSelect: (t, m, cardId) => this.openMenu(t, m, "chat", ["root"], cardId) },
          { id: "status", label: this.host.t.menuStatusAction, leaf: true, onSelect: async (t) => { await this.host.showStatus(t); } },
          { id: "task", label: this.host.t.menuTaskAction, leaf: true, onSelect: async (t) => { await this.host.showTasks(t); } },
          { id: "history", label: this.host.t.menuHistoryAction, leaf: true, onSelect: async (t) => { await this.host.showHistory(t, 10); } },
          { id: "goals", label: this.host.t.menuGoalsAction, leaf: true, onSelect: async (t) => { await this.host.showGoals(t); } },
          { id: "schedule", label: this.host.t.menuScheduleAction, leaf: true, onSelect: async (t) => { await this.host.showSchedule(t); } },
          { id: "compact", label: this.host.t.menuCompactAction, leaf: true, onSelect: async (t) => { await this.host.compact(t); } },
          { id: "plugins", label: this.host.t.menuPluginsAction, leaf: true, onSelect: async (t) => { await this.host.showPlugins(t); } },
          { id: "settings", label: this.host.t.menuSettingsAction, onSelect: (t, m, cardId) => this.openMenu(t, m, "settings", ["root"], cardId) },
        ];
      case "workspace": {
        const workspaces = this.host.listWorkspaces();
        return workspaces.map((w) => ({
          id: `dir:${w.path}`,
          label: `${w.path === this.host.workDir ? "● " : ""}${w.title}${w.title !== w.path ? `  (${w.path})` : ""}`,
          leaf: true,
          onSelect: async (t, m) => {
            this.host.workDir = w.path;
            await this.host.newChat(m);
            return this.host.t.dirSwitched(w.path);
          },
        }));
      }
      case "chat": {
        const binding = this.host.bindings.get(this.host.channel, this.host.chatKey);
        const active = binding?.sessionId;
        const hasWebMirror = binding?.webMirrorSessionId !== undefined;

        const items: MenuItem[] = (await this.host.collectWorkdirSessions()).map(({ sessionId, title }) => {
          const isMirrored = hasWebMirror && binding?.webMirrorSessionId === sessionId;
          const mirrorIndicator = isMirrored ? ` ${this.host.t.webMirrorIndicator}` : "";
          const activeIndicator = sessionId === active ? "●" : "○";
          return {
            id: `session:${sessionId}`,
            label: `${activeIndicator} ${title || sessionId}${mirrorIndicator}`,
            leaf: true,
            onSelect: async (t, m) => {
              await this.host.switchTo(sessionId, m.senderKey);
              return this.host.t.sessionSwitched(title || sessionId);
            },
          };
        });

        if (items.length === 0) {
          items.push({
            id: "none:history",
            label: this.host.t.noSessionsInWorkdir(this.host.workDir),
            leaf: true,
            onSelect: async () => this.host.t.noSessionsInWorkdir(this.host.workDir),
          });
        }

        items.push({
          id: "action:new",
          label: this.host.t.menuNewChat,
          leaf: true,
          onSelect: async (t, m, messageId) => {
            // Reuse the menu card for the confirm prompt so no stale card is left behind.
            if (await this.host.confirmAction(t, this.host.t.confirmNewText, messageId)) {
              await this.host.newChat(m);
              return this.host.t.newChatDone;
            }
            return this.host.t.actionCancelled;
          },
        });
        return items;
      }
      case "settings":
        return [
          { id: "model", label: this.host.t.menuSettingsModel, onSelect: (t, m, cardId) => this.openMenu(t, m, "model", ["settings", "root"], cardId) },
          { id: "reasoning", label: this.host.t.menuSettingsReasoning, onSelect: (t, m, cardId) => this.openMenu(t, m, "reasoning", ["settings", "root"], cardId) },
          { id: "notify", label: this.host.t.menuSettingsNotify, onSelect: (t, m, cardId) => this.openMenu(t, m, "notify", ["settings", "root"], cardId) },
          { id: "progress", label: this.host.t.menuSettingsProgress, onSelect: (t, m, cardId) => this.openMenu(t, m, "progress", ["settings", "root"], cardId) },
          { id: "language", label: this.host.t.menuSettingsLanguage, onSelect: (t, m, cardId) => this.openMenu(t, m, "language", ["settings", "root"], cardId) },
          { id: "overview", label: this.host.t.menuSettingsOverview, leaf: true, onSelect: async (t) => { await this.host.showSettings(t); } },
        ];
      case "language":
        return [
          {
            id: "lang:zh",
            label: `${this.host.language === "zh" ? "● " : ""}${this.host.t.languageZh}`,
            leaf: true,
            onSelect: async (t, m) => { await this.host.setLanguage("zh", t, m); },
          },
          {
            id: "lang:en",
            label: `${this.host.language === "en" ? "● " : ""}${this.host.t.languageEn}`,
            leaf: true,
            onSelect: async (t, m) => { await this.host.setLanguage("en", t, m); },
          },
        ];
      case "model":
        return await this.modelMenuItems();
      case "reasoning":
        return this.reasoningMenuItems();
      case "notify":
        return ([
          { id: "full", label: this.host.t.notifyFull },
          { id: "important", label: this.host.t.notifyImportant },
          { id: "result", label: this.host.t.notifyResult },
        ] as const).map((o) => ({
          id: `notify:${o.id}`,
          label: `${this.host.notifyLevel === o.id ? "● " : ""}${o.label}`,
          leaf: true,
          onSelect: async (t: OutboundTarget, m: InboundMessage) => {
            await this.host.setNotifyLevel(o.id, t, m);
          },
        }));
      case "progress": {
        const presets: { id: string; label: string; ms: number }[] = [
          { id: "progress:0", label: this.host.t.progressOff, ms: 0 },
          { id: "progress:120000", label: this.host.t.progressMinutes(2), ms: 2 * 60_000 },
          { id: "progress:300000", label: this.host.t.progressMinutes(5), ms: 5 * 60_000 },
          { id: "progress:600000", label: this.host.t.progressMinutes(10), ms: 10 * 60_000 },
          { id: "progress:900000", label: this.host.t.progressMinutes(15), ms: 15 * 60_000 },
          { id: "progress:1800000", label: this.host.t.progressMinutes(30), ms: 30 * 60_000 },
        ];
        return presets.map((o) => ({
          id: o.id,
          label: `${this.host.progressTimeoutMs === o.ms ? "● " : ""}${o.label}`,
          leaf: true,
          onSelect: async (t: OutboundTarget, m: InboundMessage) => {
            await this.host.setProgressTimeout(o.ms, t, m);
          },
        }));
      }
    }
  }

    private async modelMenuItems(): Promise<MenuItem[]> {
    const choices = await this.listModelChoices();
    const current = this.host.defaultSelection();
    const items: MenuItem[] = choices.map((c) => ({
      id: `model:${c.provider}:${c.model}`,
      label: `${c.provider === current.provider && c.model === current.model ? "● " : ""}${c.name}`,
      leaf: true,
      onSelect: async (t, m) => {
        await this.host.setModel(c.provider, c.model, m);
        return this.host.t.modelSet(c.name);
      },
    }));
    if (items.length === 0) {
      items.push({ id: "model:none", label: this.host.t.noModelsFound, leaf: true, onSelect: async () => this.host.t.noModelsFound });
    }
    return items;
  }

    private reasoningMenuItems(): MenuItem[] {
    const current = this.host.defaultSelection();
    const efforts = [
      { id: "low", name: this.host.t.effortLow },
      { id: "medium", name: this.host.t.effortMedium },
      { id: "high", name: this.host.t.effortHigh },
    ];
    const items: MenuItem[] = [
      {
        id: "effort:default",
        label: `${current.reasoningEffort === undefined ? "● " : ""}${this.host.t.effortDefault}`,
        leaf: true,
        onSelect: async (t, m) => {
          await this.host.setReasoning(undefined, m);
          return this.host.t.reasoningSet(this.host.t.effortDefault);
        },
      },
    ];
    for (const e of efforts) {
      items.push({
        id: `effort:${e.id}`,
        label: `${e.id === current.reasoningEffort ? "● " : ""}${e.name}`,
        leaf: true,
        onSelect: async (t, m) => {
          await this.host.setReasoning(e.id, m);
          return this.host.t.reasoningSet(e.name);
        },
      });
    }
    return items;
  }

    private async listModelChoices(): Promise<{ provider: string; model: string; name: string }[]> {
    const llm = this.host.ctx.get("llm") as
      | {
          listProviders?: () => { id: string; name: string }[];
          listModels?: (provider: string) => Promise<{ id: string; name: string }[]>;
        }
      | undefined;
    const providers = llm?.listProviders?.() ?? [];
    const out: { provider: string; model: string; name: string }[] = [];
    for (const p of providers) {
      let models: { id: string; name: string }[] = [];
      try {
        models = (await llm?.listModels?.(p.id)) ?? [];
      } catch {
        // Skip providers whose catalog cannot be listed.
      }
      for (const m of models) {
        out.push({ provider: p.id, model: m.id, name: this.host.t.modelName(m.name || m.id, p.name || p.id) });
      }
    }
    return out;
  }

}
