import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface SharedConfigData {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabaseJwt?: string;
  supabaseRefreshToken?: string;
}

export class SharedConfig {
  private static readonly CONFIG_DIR = path.join(os.homedir(), ".chatsync");
  private static readonly CONFIG_FILE = path.join(this.CONFIG_DIR, "config.json");

  static load(): SharedConfigData {
    try {
      if (fs.existsSync(this.CONFIG_FILE)) {
        const data = fs.readFileSync(this.CONFIG_FILE, "utf-8");
        return JSON.parse(data) as SharedConfigData;
      }
    } catch (err) {
      console.error("[SharedConfig] Failed to load config:", err);
    }
    return {};
  }

  static save(data: Partial<SharedConfigData>): void {
    try {
      if (!fs.existsSync(this.CONFIG_DIR)) {
        fs.mkdirSync(this.CONFIG_DIR, { recursive: true });
      }

      const current = this.load();
      const updated = { ...current, ...data };

      fs.writeFileSync(this.CONFIG_FILE, JSON.stringify(updated, null, 2), "utf-8");
      
      // Ensure file is private
      try {
        fs.chmodSync(this.CONFIG_FILE, 0o600);
      } catch {
        // Ignore chmod errors on windows
      }
    } catch (err) {
      console.error("[SharedConfig] Failed to save config:", err);
    }
  }

  static delete(): void {
    try {
      if (fs.existsSync(this.CONFIG_FILE)) {
        fs.unlinkSync(this.CONFIG_FILE);
      }
    } catch (err) {
      console.error("[SharedConfig] Failed to delete config:", err);
    }
  }
}
