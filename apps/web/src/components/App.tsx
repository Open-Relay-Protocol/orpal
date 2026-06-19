import { useState } from "react";
import { OrpalProvider, useOrpal } from "../state/orpal-context.js";
import { Sidebar } from "./Sidebar.js";
import { Conversation } from "./Conversation.js";
import { IdentityModal } from "./IdentityModal.js";
import { AddContactModal } from "./AddContactModal.js";
import { SettingsModal } from "./SettingsModal.js";
import { MigrationWizardModal } from "./MigrationWizardModal.js";
import { MigrationPromptModal } from "./MigrationPromptModal.js";
import { CrabMascot } from "./CrabMascot.js";

function Shell() {
  const { status, errorMsg, selected, pendingIncomingMigrations } = useOrpal();
  const [modal, setModal] = useState<null | "identity" | "add" | "settings" | "migration">(null);
  const [dismissedPrompts, setDismissedPrompts] = useState<Set<string>>(new Set());

  const activePrompt = pendingIncomingMigrations.find(
    (p) => !dismissedPrompts.has(p.contactKey),
  );

  if (status === "loading") {
    return <div className="center muted">Starting Orpal…</div>;
  }
  if (status === "error") {
    return (
      <div className="center">
        <div className="error-box">
          <CrabMascot className="error-mascot" status="down" />
          <h2>Couldn’t start</h2>
          <p className="muted">{errorMsg}</p>
        </div>
      </div>
    );
  }

  // On narrow (phone) viewports only one pane shows at a time; this class tells
  // the CSS whether to reveal the contact list or the open conversation. Wider
  // tablets and foldables show both panes side by side (see styles.css).
  return (
    <div className={`app ${selected ? "app--conversation" : "app--list"}`}>
      <Sidebar
        onShowIdentity={() => setModal("identity")}
        onAddContact={() => setModal("add")}
        onSettings={() => setModal("settings")}
        onMigration={() => setModal("migration")}
      />
      <Conversation />
      {modal === "identity" && <IdentityModal onClose={() => setModal(null)} />}
      {modal === "add" && <AddContactModal onClose={() => setModal(null)} />}
      {modal === "settings" && <SettingsModal onClose={() => setModal(null)} />}
      {modal === "migration" && <MigrationWizardModal onClose={() => setModal(null)} />}
      {!modal && activePrompt && (
        <MigrationPromptModal
          pending={activePrompt}
          onClose={() =>
            setDismissedPrompts((prev) => new Set([...prev, activePrompt.contactKey]))
          }
        />
      )}
    </div>
  );
}

export function App() {
  return (
    <OrpalProvider>
      <Shell />
    </OrpalProvider>
  );
}
