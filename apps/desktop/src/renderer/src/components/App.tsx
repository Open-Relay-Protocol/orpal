import { useState } from "react";
import { OrpalProvider, useOrpal } from "../state/orpal-context.js";
import { Sidebar } from "./Sidebar.js";
import { Conversation } from "./Conversation.js";
import { IdentityModal } from "./IdentityModal.js";
import { AddContactModal } from "./AddContactModal.js";
import { SettingsModal } from "./SettingsModal.js";
import { CrabMascot } from "./CrabMascot.js";

function Shell() {
  const { status, errorMsg } = useOrpal();
  const [modal, setModal] = useState<null | "identity" | "add" | "settings">(null);

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

  return (
    <div className="app">
      <Sidebar
        onShowIdentity={() => setModal("identity")}
        onAddContact={() => setModal("add")}
        onSettings={() => setModal("settings")}
      />
      <Conversation />
      {modal === "identity" && <IdentityModal onClose={() => setModal(null)} />}
      {modal === "add" && <AddContactModal onClose={() => setModal(null)} />}
      {modal === "settings" && <SettingsModal onClose={() => setModal(null)} />}
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
