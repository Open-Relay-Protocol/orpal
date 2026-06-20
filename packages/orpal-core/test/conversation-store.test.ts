import { describe, it, expect } from "vitest";
import { InMemoryConversationStore, type StoredMessage } from "../src/index.js";

// ORPAL-012 (#34): getMessage(id) is the O(1) primary-key lookup that replaces the
// old listMessages().find() scans on every delivery-state transition.

function textMsg(id: string, contactKey: string, ts: number): StoredMessage {
  return { id, contactKey, direction: "out", kind: "text", text: `hi ${id}`, ts, state: "queued" };
}

describe("InMemoryConversationStore.getMessage", () => {
  it("returns a stored message by id, regardless of contact", async () => {
    const store = new InMemoryConversationStore();
    await store.appendMessage(textMsg("m1", "alice", 100));
    await store.appendMessage(textMsg("m2", "bob", 200));

    const found = await store.getMessage("m2");
    expect(found?.id).toBe("m2");
    expect(found?.contactKey).toBe("bob");
    expect(found?.text).toBe("hi m2");
  });

  it("returns null for an unknown id", async () => {
    const store = new InMemoryConversationStore();
    expect(await store.getMessage("nope")).toBeNull();
  });

  it("reflects updates made via updateMessage", async () => {
    const store = new InMemoryConversationStore();
    await store.appendMessage(textMsg("m1", "alice", 100));
    await store.updateMessage("m1", { state: "delivered" });

    const found = await store.getMessage("m1");
    expect(found?.state).toBe("delivered");
  });

  it("returns a copy so callers cannot mutate stored state", async () => {
    const store = new InMemoryConversationStore();
    await store.appendMessage(textMsg("m1", "alice", 100));

    const first = await store.getMessage("m1");
    first!.state = "failed";

    const second = await store.getMessage("m1");
    expect(second?.state).toBe("queued");
  });
});
