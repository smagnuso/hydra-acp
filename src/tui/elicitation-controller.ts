// Queue and lifecycle for agent form questions in the TUI: one wizard shows
// at a time on the shared form slot, later requests wait their turn. The
// reply goes out when the wizard finishes, or "cancel" when the session tears
// down or a sibling client answered first.

import type { KeyEvent } from "./input.js";
import { parseElicitation, type ElicitationOutcome } from "./elicitation-form.js";
import { createElicitationFlow, type ElicitationFlow } from "./elicitation-list.js";
import type { FormState } from "./modal-form.js";
import type { FormClickTarget } from "./screen.js";

export interface ElicitationUi {
  show(form: FormState): void;
  hide(): void;
}

interface Entry {
  id: string | undefined;
  wizard: ElicitationFlow;
  resolve: (result: unknown) => void;
}

export class ElicitationController {
  private active: Entry | null = null;
  private readonly queue: Entry[] = [];

  constructor(private readonly ui: ElicitationUi) {}

  get isActive(): boolean {
    return this.active !== null;
  }

  // Resolves with the ACP response. Null when this form cannot be rendered
  // here, so the caller abstains and another client can take it.
  request(params: unknown): Promise<unknown> | null {
    const parsed = parseElicitation(params);
    if (parsed === null) {
      return null;
    }
    const meta = (params as { _meta?: Record<string, { elicitationId?: unknown }> })
      ._meta?.["hydra-acp"];
    const id = typeof meta?.elicitationId === "string" ? meta.elicitationId : undefined;
    return new Promise<unknown>((resolve) => {
      this.queue.push({ id, wizard: createElicitationFlow(parsed), resolve });
      this.showNext();
    });
  }

  handleKey(ev: KeyEvent): void {
    this.apply(this.active?.wizard.handleKey(ev));
  }

  handleClick(target: FormClickTarget): void {
    this.apply(this.active?.wizard.handleClick(target));
  }

  // A sibling client answered (elicitation_resolved) or the agent gave up.
  dismissExternally(id: unknown): void {
    if (typeof id !== "string") {
      return;
    }
    const queued = this.queue.findIndex((e) => e.id === id);
    if (queued >= 0) {
      const [gone] = this.queue.splice(queued, 1);
      gone!.resolve({ action: "cancel" });
      return;
    }
    if (this.active?.id === id) {
      this.finish({ action: "cancel" });
    }
  }

  cancelAll(): void {
    for (const e of this.queue.splice(0)) {
      e.resolve({ action: "cancel" });
    }
    this.finish({ action: "cancel" });
  }

  private showNext(): void {
    if (this.active !== null) {
      return;
    }
    const next = this.queue.shift();
    if (next === undefined) {
      return;
    }
    this.active = next;
    this.ui.show(next.wizard.form);
  }

  private finish(response: unknown): void {
    const done = this.active;
    if (done === null) {
      return;
    }
    this.active = null;
    this.ui.hide();
    done.resolve(response);
    this.showNext();
  }

  private apply(outcome: ElicitationOutcome | undefined): void {
    if (outcome === undefined || this.active === null) {
      return;
    }
    if (outcome.type === "done") {
      this.finish(outcome.response);
      return;
    }
    if (outcome.type === "update") {
      this.ui.show(this.active.wizard.form);
    }
  }
}
