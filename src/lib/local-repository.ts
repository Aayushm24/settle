import { StateRepository } from "@/lib/repository";
import { SettleState } from "@/lib/types";

const STORAGE_KEY = "settle_state_v1";

export function createLocalRepository(): StateRepository {
  return {
    mode: "local",
    async load() {
      if (typeof window === "undefined") {
        return null;
      }

      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }

      try {
        return JSON.parse(raw) as SettleState;
      } catch {
        return null;
      }
    },
    async save(state) {
      if (typeof window === "undefined") {
        return;
      }

      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    },
  };
}
