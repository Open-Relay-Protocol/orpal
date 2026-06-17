import { describe, it, expect } from "vitest";
import { DeviceIdentity, verifyBinding } from "../src/orp.js";

// Smoke test: proves the vendored ORP reference compiles and resolves through the
// ./orp.js seam, and that its @noble-backed crypto runs in this toolchain.
describe("orp seam", () => {
  it("generates a device identity with a valid self-signed binding", () => {
    const id = DeviceIdentity.generate();
    expect(id.identityKeyB64).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.transportKeyB64).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyBinding(id.binding)).toBe(true);

    // The binding ties THIS identity to THIS transport key.
    expect(id.binding.identity_key).toBe(id.identityKeyB64);
    expect(id.binding.transport_key).toBe(id.transportKeyB64);
  });
});
