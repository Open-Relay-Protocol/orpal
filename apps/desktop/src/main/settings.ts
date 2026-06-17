// App settings persisted as JSON in userData (board endpoint, ICE servers,
// relay-only default). Not secret — only the private keys go through safeStorage.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS, type DesktopSettings } from "../shared/ipc.js";

export class SettingsStore {
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, "settings.json");
  }

  async get(): Promise<DesktopSettings> {
    try {
      const raw = await readFile(this.file, "utf8");
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<DesktopSettings>) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async set(settings: DesktopSettings): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(settings, null, 2), "utf8");
  }
}
